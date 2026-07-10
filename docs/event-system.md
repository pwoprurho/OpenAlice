# Event System (Legacy Compatibility Surface)

The former event/listener/producer system is no longer OpenAlice's scheduling
or agent-execution architecture. Current automation is owned by self-describing
Workspace issues:

- [[docs/workspace-issues-and-scheduling.md]] — [Workspace issues and scheduling](workspace-issues-and-scheduling.md)
- [[docs/project-structure.md]] — [Project structure](project-structure.md)

Do not add new agent workflows, connectors, or schedules by extending
`AgentEvents`, `ListenerRegistry`, or the webhook `agent.work.requested` type.

## What Still Exists

Legacy code remains under `src/core/{agent-event,event-log,event-bus,listener,
producer,listener-registry}.ts` plus the Flow/Webhook routes and UI. It currently
provides event-log queries, SSE, topology visualization, and authenticated
external event ingestion.

Several registered event types are dormant compatibility types with no active
producer or consumer. In particular, accepting `task.requested` /
`agent.work.requested` only records and publishes an event; it does not start a
Workspace agent. Cleanup of the misleading execution contract is tracked in
[GitHub issue #502](https://github.com/TraderAlice/OpenAlice/issues/502).

Treat this surface as code awaiting retirement or deliberate reassignment, not
as a subsystem to grow. If a change must touch it:

1. verify the actual producer/listener topology rather than trusting registered
   type names;
2. preserve webhook authentication and default-deny behavior while the route
   exists;
3. keep demo handlers and the Automation UI aligned with observed behavior;
4. prefer deleting dead paths or redirecting callers to Workspace issues over
   adding another compatibility layer.

Git history preserves the former event-system extension guide if archaeology
is required.
