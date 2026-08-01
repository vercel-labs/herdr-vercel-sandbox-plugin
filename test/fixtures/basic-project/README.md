# Agent conformance fixture

The live adapter test asks the remote agent to create `agent-conformance-output.txt`, applies the resulting Git patch locally, stops the Sandbox, resumes it, and confirms the file and agent credential persist.
