# Current PoC architecture

```text
Web Console -> Agent API -> Browser Worker -> Mock site
                      \-> Agent Core contracts and policy
```

The services are separate npm workspaces so the future AzureChat integration can call the same Agent API without embedding browser execution inside AzureChat.

The current Run Store is deliberately in-memory. Before deployment it must be replaced by a durable store and queue, and the Browser Worker must run in an isolated environment.

The mock worker proves one bounded loop:

1. capture an observation
2. select one typed action
3. pass the action through policy checks
4. execute the mock action
5. capture a second observation
6. verify the expected screen evidence

No Azure OpenAI request, real browser session, or DeskNet's access occurs in this milestone.
