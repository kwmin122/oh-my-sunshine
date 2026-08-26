# MASTER SPEC — Medical Scout (Demo)

## Requirements
- [REQ-001] Should unauthenticated users view any part? → B — public read-only trends, login for alerts
- [REQ-002] Do roles differ? → B — User / Admin
- [REQ-003] Which external providers at launch? → Government procurement APIs + supplier feeds
- [REQ-004] Degrade or fail loudly when upstream dies? → A — degrade gracefully with cached data
- [REQ-005] Must-have behaviors at launch? → Trend list, drill-down chart, email alert
- [REQ-006] Core persisted entities? → Supplier, Product, TrendSnapshot, Alert
- [REQ-007] Security requirements at launch? → B — baseline plus audit logging
- [REQ-008] What proves it works end to end? → Alert arrives within 5 minutes of trend detection