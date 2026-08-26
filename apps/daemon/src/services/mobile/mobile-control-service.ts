import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type {
  Approval,
  Decision,
  GatewayAction,
  MobileDevice,
  MobileMessage,
  MobileOutbound,
  PairingRequest,
  PairingResult,
  ProjectId,
} from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";

/**
 * MobilePairingService (§5.17): QR-style pairing with short-lived single-use tokens,
 * role-restricted devices (VIEWER/OPERATOR/ADMIN), and revocable sessions.
 * Tokens are stored only as hashes — a leaked DB row cannot pair a device.
 */
export class MobilePairingService {
  private readonly pendingTokens = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
  ) {}

  beginPairing(projectId: ProjectId | null, request: PairingRequest): PairingResult {
    const device: MobileDevice = {
      id: newId("dev"),
      name: request.deviceName,
      role: request.requestedRole,
      deviceIdentity: randomBytes(16).toString("hex"),
      status: "PENDING_PAIRING",
      pairedAt: null,
      lastSeenAt: null,
      revokedAt: null,
    };
    this.docs.put("mobile_device", device.id, projectId, device);
    const token = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    this.pendingTokens.set(tokenHash, { deviceId: device.id, expiresAt: Date.now() + this.PAIRING_TOKEN_TTL_MS });
    return { deviceId: device.id, pairingToken: token, expiresAt: new Date(Date.now() + this.PAIRING_TOKEN_TTL_MS).toISOString() };
  }

  /** Single-use: the token is consumed on first successful exchange. */
  completePairing(token: string): MobileDevice {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const pending = this.pendingTokens.get(tokenHash);
    if (!pending) throw new Error("[mobile-pairing] invalid pairing token");
    this.pendingTokens.delete(tokenHash);
    if (Date.now() > pending.expiresAt) throw new Error("[mobile-pairing] pairing token expired");

    const device = this.docs.require<MobileDevice>("mobile_device", pending.deviceId);
    if (device.status === "REVOKED") throw new Error("[mobile-pairing] device was revoked");
    const paired: MobileDevice = { ...device, status: "PAIRED", pairedAt: new Date().toISOString() };
    this.docs.put("mobile_device", paired.id, null, paired);
    this.events.append({
      projectId: "" as ProjectId,
      type: "mobile.device_paired",
      entityType: "mobile_device",
      entityId: paired.id,
      actorType: "USER",
      payload: { name: paired.name, role: paired.role },
    });
    return paired;
  }

  /** Constant-time device-token check for API auth. */
  authenticate(deviceId: string, presentedSecret: string): MobileDevice {
    const device = this.docs.require<MobileDevice>("mobile_device", deviceId);
    if (device.status !== "PAIRED") throw new Error("[mobile-pairing] device not paired");
    const expected = Buffer.from(createHash("sha256").update(device.deviceIdentity).digest("hex"));
    const presented = Buffer.from(presentedSecret.toLowerCase());
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new Error("[mobile-pairing] device authentication failed");
    }
    const seen: MobileDevice = { ...device, lastSeenAt: new Date().toISOString() };
    this.docs.put("mobile_device", seen.id, null, seen);
    return device;
  }

  revoke(deviceId: string): MobileDevice {
    const device = this.docs.require<MobileDevice>("mobile_device", deviceId);
    const revoked: MobileDevice = { ...device, status: "REVOKED", revokedAt: new Date().toISOString() };
    this.docs.put("mobile_device", revoked.id, null, revoked);
    this.events.append({
      projectId: "" as ProjectId,
      type: "mobile.device_revoked",
      entityType: "mobile_device",
      entityId: revoked.id,
      actorType: "USER",
      payload: { name: revoked.name },
    });
    return revoked;
  }

  listDevices(): MobileDevice[] {
    return this.docs.list<MobileDevice>("mobile_device");
  }
}

type RolePermissions = {
  viewStatus: boolean;
  chat: boolean;
  answerDecisions: boolean;
  approveActions: boolean; // non-dangerous
  approveDangerous: boolean;
  pauseResume: boolean;
};

const ROLE_PERMISSIONS: Record<MobileDevice["role"], RolePermissions> = {
  VIEWER: { viewStatus: true, chat: false, answerDecisions: false, approveActions: false, approveDangerous: false, pauseResume: false },
  OPERATOR: { viewStatus: true, chat: true, answerDecisions: true, approveActions: true, approveDangerous: false, pauseResume: true },
  ADMIN: { viewStatus: true, chat: true, answerDecisions: true, approveActions: true, approveDangerous: true, pauseResume: true },
};

/**
 * MobileControlService (§5.17): every mobile message becomes structured state or an
 * explicit refusal. Chat never bypasses the workflow engine; commands pass through the
 * same Action Gateway; VIEWER devices can do nothing but look.
 */
export class MobileControlService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly hooks: {
      resolveDecision(decisionId: string, chosenOption: string): void;
      resolveApproval(approvalId: string, outcome: "ALLOW_ONCE" | "APPROVED" | "REJECTED" | "CANCELLED"): Promise<void>;
      pauseTask(taskId: string): void;
      resumeTask(taskId: string): Promise<void>;
      leadReply(projectId: string, question: string): Promise<string>;
    },
  ) {}

  async handleMessage(device: MobileDevice, message: MobileMessage): Promise<MobileOutbound> {
    this.recordMessage(device, message);
    const perms = ROLE_PERMISSIONS[device.role];
    const reply = async (text: string, severity: MobileOutbound["severity"] = "INFO"): Promise<MobileOutbound> =>
      this.outbound("LEAD_REPLY", severity, text, message.refId);

    switch (message.kind) {
      case "CHAT": {
        if (!perms.chat) return reply(`device role '${device.role}' cannot converse — VIEWER is read-only`, "WARN");
        const leadAnswer = await this.hooks.leadReply(message.refId ?? "", message.text);
        // If the chat message maps to an open decision by id reference, it must go through DECISION_ANSWER.
        return reply(leadAnswer);
      }
      case "DECISION_ANSWER": {
        if (!perms.answerDecisions) return reply(`device role '${device.role}' cannot answer decisions`, "WARN");
        const decision = message.refId ? this.docs.get<Decision>("decision", message.refId) : null;
        if (!decision || decision.status !== "OPEN") return reply("no open decision referenced", "WARN");
        this.hooks.resolveDecision(decision.id, message.text);
        return reply(`decision ${decision.stableKey} answered with "${message.text}" — work resumed`);
      }
      case "APPROVAL_OUTCOME": {
        const approval = message.refId ? this.docs.get<Approval>("approval", message.refId) : null;
        if (!approval || approval.status !== "REQUESTED") return reply("no open approval referenced", "WARN");
        const action = approval.actionId ? this.docs.get<GatewayAction>("action", approval.actionId) : null;
        const dangerous = action?.risk === "DANGEROUS";
        if (dangerous && !perms.approveDangerous) {
          return reply(`role '${device.role}' cannot approve DANGEROUS actions — ADMIN required`, "CRITICAL");
        }
        if (!perms.approveActions) return reply(`device role '${device.role}' cannot approve actions`, "WARN");
        const outcome = message.text.toUpperCase().includes("REJECT") ? "REJECTED" : "ALLOW_ONCE";
        await this.hooks.resolveApproval(approval.id, outcome);
        return reply(`${dangerous ? "dangerous " : ""}action ${outcome === "REJECTED" ? "rejected" : "allowed once"} via mobile`);
      }
      case "COMMAND": {
        if (!perms.pauseResume) return reply(`device role '${device.role}' cannot control execution`, "WARN");
        const cmd = message.text.trim().toLowerCase();
        if (cmd.startsWith("pause ")) {
          this.hooks.pauseTask(cmd.slice(6));
          return reply("task paused");
        }
        if (cmd.startsWith("resume ")) {
          await this.hooks.resumeTask(cmd.slice(7));
          return reply("task resume requested through workflow engine");
        }
        return reply("supported commands: pause <taskId>, resume <taskId>", "WARN");
      }
    }
  }

  /** Notifications are events first — transport adapters fan out from the event stream. */
  notify(projectId: string, text: string, severity: MobileOutbound["severity"] = "INFO", refId: string | null = null): MobileOutbound {
    return this.outbound("NOTIFICATION", severity, text, refId, projectId);
  }

  private recordMessage(device: MobileDevice, message: MobileMessage): void {
    // Attribute the event to the referenced entity's project so the timeline stays coherent.
    let projectId: string = "";
    if (message.refId) {
      const decision = this.docs.get<Decision>("decision", message.refId);
      const approval = this.docs.get<Approval>("approval", message.refId);
      const task = this.docs.get<{ projectId: string }>("task", message.refId);
      projectId = decision?.projectId ?? approval?.projectId ?? task?.projectId ?? "";
    }
    this.events.append({
      projectId: projectId as ProjectId,
      type: "mobile.message_received",
      entityType: "mobile_message",
      entityId: message.id,
      actorType: "USER",
      payload: { deviceId: device.id, kind: message.kind, refId: message.refId },
    });
  }

  private outbound(kind: MobileOutbound["kind"], severity: MobileOutbound["severity"], text: string, refId: string | null, projectId: string = ""): MobileOutbound {
    const outboundMessage: MobileOutbound = { kind, severity, text, refId, sentAt: new Date().toISOString() };
    this.events.append({
      projectId: projectId as ProjectId,
      type: "mobile.notification_sent",
      entityType: "mobile_outbound",
      actorType: "ENGINE",
      payload: { kind, severity, text },
    });
    return outboundMessage;
  }
}
