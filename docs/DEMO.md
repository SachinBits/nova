# Demo

1. Start a lab run and stay in the War Room. Point out how the SQL lookup exposes an order ID and IDOR Runner uses it in the next probe, then how SSRF Hunter, Proto Polluter and Supply Saboteur each confirm a modern attack.
2. Open Findings and compare the customer lookup before and after its policy. The legitimate lookup still returns Alice's record.
3. Return to the Live feed and approve the order ownership policy. Open the order finding to compare the original cross-account response, the replay's 404 and the owner's successful request.
4. Push a commit that introduces a vulnerability to a watched repository. The push appears in the War Room sidebar, the agents review it, and the commit on GitHub gets a failing `hex/security-review` status with a comment listing the new finding.
5. Push a revert. The next review reports the finding as fixed and the status passes.
6. Paste a GitHub link on the home page to review any public repository, and download the fixed project with its report.
