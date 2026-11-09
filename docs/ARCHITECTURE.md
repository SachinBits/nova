# Hex architecture

The Next.js Node runtime serves the React workspace and the same-origin arena API. The browser polls for snapshots. A server-side scheduler executes the run even when the tab closes, while the API can resume a due run after a server restart. SQLite stores each run, its decisions, and its evidence under the browser's session identifier. Keep the app on one process with persistent local disk.

- Scout selects a Red tool and payload using the shared evidence. Injector executes an actual SQLite query against fresh synthetic data. IDOR Runner can use the order ID from the lookup evidence. The assistant check runs against an intentionally vulnerable deterministic fixture.
- Sentinel detects exposures using response assertions. OpenAI selects one strict function call per agent turn. Hex validates the action against the current lab state, executes it, and supplies the result as context for the next turn. Triage and Director can explain the results, and Jev can add an advisory escalation probability.
- Patch Engineer selects candidate policies. The Verifier runs the exact attack and a legitimate control against the candidate. Broad quarantine fails the control and rolls back. Blue can use that result to select a narrower policy. Containment gates the order policy on an operator decision.
- Verification compares the original exposure with the attack replay and a legitimate control. A candidate policy is retained as verified only if both assertions pass. Declining leaves the finding open. Every new exercise starts from the intentionally vulnerable baseline.
- The exported receipt contains synthetic request and response evidence, outcomes, timestamps and a SHA-256 digest. The digest is an integrity checksum, with no signer identity.

The private target is an in-process request handler scoped to this lab. Shared evidence and the scheduler coordinate agents inside one process.
