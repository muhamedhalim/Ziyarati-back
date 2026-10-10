# Transfer impact assessment (worksheet)

Residency plan sections 9, 18. **A worksheet with the factual columns filled from the repository and every legal column left open.** No conclusion is drawn here: whether a transfer is permitted, which safeguard applies and whether a risk assessment is mandatory are `LC` (L2, L10). The SDAIA transfer regulation, SCCs and risk-assessment guideline could not be read from the build environment (`OV`); take the criteria from the official texts, not from this file.

## Gate per flow (plan section 9)

A flow that leaves the Kingdom may run in production only when **all five** are evidenced; otherwise it is disabled by feature flag, not left running.

1. Legal basis (L11)
2. DPA evidence (`SUBPROCESSORS.md`)
3. SCC evidence, or counsel's written alternative (L10)
4. Transfer risk assessment, where counsel says it is required
5. The minimisation control named in `DATA-FLOW.md`

## Worksheet

Facts are from `DATA-FLOW.md` and `SUBPROCESSORS.md`. A blank cell is open. Status of gates 1-4 is **missing** for every row today: no DPA, SCC, assessment or legal basis document is held in this repository.

| Flow | Processor | Data classes | Health data | Volume / frequency | Minimisation (gate 5) | Off switch if gates are missing | 1 basis | 2 DPA | 3 SCC | 4 risk assessment |
|---|---|---|---|---|---|---|---|---|---|---|
| F1-F2 pages and REST | Vercel | D2, D4, D6 | yes | | direct API routing (built, off until `NEXT_PUBLIC_API_BASE_URL` is set) | set the variable; REST leaves Vercel | | | | |
| F3 analytics | Vercel | D1 | no (public pages only) | | public routes only | remove `PublicAnalytics` | | | | |
| F8 AI chat | OpenAI | D2, D4 | yes | | `AiMinimizer` | `AI_MINIMIZER_ENABLED` is a safety switch, **not** an off switch; disable the AI feature per tenant/plan | | | | |
| F9 AI vision | OpenAI | D2, D3, D4 | yes | | off by default | `AI_VISION_ENABLED=false` | | | | |
| F10 embeddings / batch | OpenAI | D2, D4 | possible | | `scrubForEmbedding`; batch upload seam scrubs chat batches, embeddings batches carry clinic knowledge as written | disable knowledge ingestion / batch jobs | | | | |
| F11 WhatsApp | Meta | D2 | possible | | content policy at both send seams | disable the WhatsApp channel per tenant | | | | |
| F13 payments | Tap | D2, D5 | no | | hosted page; no card data stored | disable online payment | | | | |
| F14 e-mail | Resend / SES | D2 | possible | | minimal notices, free-text redaction | `EMAIL_PROVIDER=noop` | | | | |
| F7 storage | Cloudflare R2 | D2, D4 | yes | | none beyond encryption (migration to the approved Region planned) | - | | | | |
| F5-F6, F15-F16 hosting | Railway (now) / AWS (planned) | D2-D8 | yes | | see `DATA-RESIDENCY.md` | - | | | | |

## Risk-assessment inputs (to hand to counsel)

For each flow counsel decides to assess, the technical inputs available are: the data classes above, the field-level allow-lists and redaction code named in `DATA-FLOW.md`, the vendor's region / retention / sub-processor answers once obtained (`VC`), encryption in transit (TLS) and at rest where applicable, and the DPIA inventory (`DATA-CLASSIFICATION.md`; the export tool is not built).

Sign-off for each row: assessor, date, outcome, review date. Record it in the contract repository and reference it from `compliance/production-gate.yaml` (`scc-or-alternative`); do not commit privileged opinions to this repository.
