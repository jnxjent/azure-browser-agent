# Current PoC architecture

```text
Web Console -> Agent API -> Browser Worker -> Mock site
                      \-> Agent Core contracts and policy
```

The services are separate npm workspaces so the future AzureChat integration can call the same Agent API without embedding browser execution inside AzureChat.

The current Run Store is deliberately in-memory. Before deployment it must be replaced by a durable store and queue, and the Browser Worker must run in an isolated environment.

The mock worker uses headless Chromium to prove one bounded loop:

1. render an isolated in-memory mock portal and capture a PNG observation
2. select one typed action
3. pass the action through policy checks
4. execute the mock action
5. capture a second PNG observation
6. verify the expected screen evidence

The DeskNet's read-only path will inspect both participant and facility availability
from an unsaved schedule form. Candidate times are retained only when every
participant is free and at least one requested facility is free. The final Add
control is a write boundary and remains prohibited until an explicit approval flow
is implemented.

The PNG files are written under the ignored `screenshots/` directory and are only exposed through a run-scoped API route with fixed artifact names.

No Azure OpenAI request or DeskNet's access occurs in this milestone.
