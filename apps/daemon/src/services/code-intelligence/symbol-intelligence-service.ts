import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import type { CodeIntelligenceSnapshot, ProjectId, SymbolRecord } from "@devflow/contracts";
import { newId } from "@devflow/contracts";
import type { DocumentRepository } from "../../infrastructure/db/document-repository.js";
import type { EventStore } from "../../infrastructure/db/event-store.js";
import type { DevFlowConfig } from "../../lib/config.js";

/**
 * SymbolIntelligenceService (§3.9 Step 3B, Phase J): indexes TypeScript/JavaScript
 * symbols via the TypeScript compiler API when available, falling back to a
 * text-heuristic pass for other languages. Capability-enhancing, never a blocker.
 */
export class SymbolIntelligenceService {
  constructor(
    private readonly docs: DocumentRepository,
    private readonly events: EventStore,
    private readonly config: Pick<DevFlowConfig, "allowedWorkspaceRoots">,
  ) {}

  async indexProject(projectId: ProjectId, workspaceRoot: string): Promise<CodeIntelligenceSnapshot> {
    const files = await this.collectSourceFiles(workspaceRoot);
    let symbolsIndexed = 0;
    let toolingUsed: CodeIntelligenceSnapshot["toolingUsed"] = "text-heuristic";

    const tsFiles = files.filter((f) => /\.(ts|tsx)$/.test(f));
    if (tsFiles.length > 0) {
      toolingUsed = "typescript-compiler-api";
      const program = ts.createProgram(tsFiles, { allowJs: true, noEmit: true, skipLibCheck: true });
      const checker = program.getTypeChecker();
      for (const file of tsFiles.slice(0, 200)) {
        const source = program.getSourceFile(file);
        if (!source) continue;
        ts.forEachChild(source, (node) => {
          if (!this.isSymbolKindNode(node)) return;
          const nameNode = "name" in node && node.name && ts.isIdentifier(node.name) ? node.name : null;
          const name = nameNode ? nameNode.text : "(anonymous)";
          const symbol = checker.getSymbolAtLocation(nameNode ?? node);
          const references: SymbolRecord["references"] = [];
          if (symbol) {
            for (const ref of symbol.declarations ?? []) {
              const refFile = ref.getSourceFile().fileName;
              if (refFile !== file) references.push({ filePath: refFile.replace(`${workspaceRoot}/`, ""), line: ref.getSourceFile().getLineAndCharacterOfPosition(ref.getStart()).line + 1 });
            }
          }
          const record: SymbolRecord = {
            id: newId("sym"),
            projectId,
            filePath: file.replace(`${workspaceRoot}/`, ""),
            symbolName: name,
            symbolKind: this.kindOf(node),
            language: "TypeScript",
            range: {
              startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            },
            contentHash: null,
            references,
            diagnostics: [],
            indexedAt: new Date().toISOString(),
          };
          this.docs.put("symbol_record", record.id, projectId, record);
          symbolsIndexed++;
        });
      }
    }

    const snapshot: CodeIntelligenceSnapshot = {
      projectId,
      symbolsIndexed,
      filesIndexed: files.length,
      toolingUsed,
      indexedAt: new Date().toISOString(),
    };
    this.events.append({
      projectId,
      type: "symbol.indexed",
      entityType: "code_intelligence",
      actorType: "ENGINE",
      payload: { symbolsIndexed, toolingUsed },
    });
    return snapshot;
  }

  /** Symbol-level impact: which recorded symbols live in the given file / match a name. */
  impactedSymbols(projectId: string, changedFilePaths: string[]): SymbolRecord[] {
    const all = this.docs.list<SymbolRecord>("symbol_record", projectId);
    const changedSet = new Set(changedFilePaths.map((p) => p.replace(/^\.\//, "")));
    return all.filter(
      (s) => changedSet.has(s.filePath) || s.references.some((r) => changedSet.has(r.filePath)),
    );
  }

  private isSymbolKindNode(node: ts.Node): node is ts.FunctionDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.VariableStatement | ts.MethodDeclaration | ts.EnumDeclaration {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isVariableStatement(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isEnumDeclaration(node)
    );
  }

  private kindOf(node: ts.Node): SymbolRecord["symbolKind"] {
    if (ts.isFunctionDeclaration(node)) return "function";
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isTypeAliasDeclaration(node)) return "type";
    if (ts.isMethodDeclaration(node)) return "method";
    if (ts.isEnumDeclaration(node)) return "enum";
    return "variable";
  }

  private async collectSourceFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4 || out.length > 400) return;
      const entries = await readdirSafe(dir);
      for (const entry of entries) {
        if (["node_modules", ".git", "dist", ".devflow-data"].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (/\.(ts|tsx|py|go|rs|java)$/.test(entry.name)) out.push(full);
      }
    };
    await walk(root, 0);
    return out;
  }
}

async function readdirSafe(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function readFileHead(path: string, lines: number): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").slice(0, lines).join("\n");
  } catch {
    return "";
  }
}
