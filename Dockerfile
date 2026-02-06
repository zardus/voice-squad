FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Core tools
RUN apt-get update && apt-get install -y \
    curl \
    git \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    sudo \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Docker-in-docker
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    && rm -rf /var/lib/apt/lists/*

# Node.js (for claude code and codex)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code + Codex
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Set up ubuntu user
RUN useradd -m -s /bin/bash -G docker ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

COPY entrypoint.sh /entrypoint.sh
COPY launch-squad.sh /opt/squad/launch-squad.sh
RUN chmod +x /entrypoint.sh /opt/squad/launch-squad.sh

COPY captain/instructions.md /opt/squad/captain/instructions.md
COPY worker/instructions.md /opt/squad/worker/instructions.md
COPY mcp-config.json /opt/squad/mcp-config.json

USER ubuntu
WORKDIR /home/ubuntu

ENTRYPOINT ["/entrypoint.sh"]
