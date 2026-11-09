# Demo

1. Start a lab run and stay in the War room. Point out how the SQL lookup exposes an order ID and IDOR Runner uses that value in the next probe.
2. Open Findings and compare the customer lookup before and after its candidate policy. The legitimate lookup still returns Alice's record.
3. Return to the Live feed, then approve the order ownership policy. Open the order finding to compare the original cross-account response, the replay's 404 and the owner's successful request.
4. Show the measured scoreboard and export the evidence receipt. Refresh to demonstrate that the run remains in history.
5. Start a second exercise and leave the order finding open to demonstrate the operator's control over the mitigation.
