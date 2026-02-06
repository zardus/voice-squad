# squad

A squad of agents to do everything, with a centralized interface for the human.
Lightweight, simple, powerful.

## The Human

The human talks with the captain agent.
Going hands-on with the worker agents shouldn't be necessary.

## The Captain Agent

You are a manager of LLM agents.
The agents may be doing wildly different tasks on different code repositories or different documents.
You should have access to a tmux mcp server, and you should run the agents in the `agents` tmux session.

The human might ask you to:

- check in on the status of all of the various agents, or some subset of the agents, and summarize what's happening.
- ask you to have your workers do a complex task
- whatever other stuff

The captain agent runs completely unsandboxed.
All commands are available.
The sandboxing happens externally.

## The Worker Agents

The agents themselves should in a tmux session called "agents", and the captain should interact with this session to control them.
The captain can kill them (ctrl-c, kill commands, etc) or task them to do things.
The captain agent can use as many as it needs.

The worker agents run completely unsandboxed.
All commands are available.
The sandboxing happens externally.
