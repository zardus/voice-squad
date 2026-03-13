FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    sudo \
    jq \
    procps \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI (hub manages sibling project containers)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Generate UTF-8 locale
RUN locale-gen en_US.UTF-8

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Set up ubuntu user
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Shared volume directory for cross-container sharing (tmux sockets, auth, ssh-agent)
RUN mkdir -p /run/squad/tmux/overseer /run/squad/tmux/projects /run/squad/auth \
    && chown -R ubuntu:ubuntu /run/squad

# Build metadata
ARG GIT_COMMIT=unknown
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > /tmp/build-time.txt

# Hub server
COPY package.json server.js tmux-bridge.js stt.js tts.js status-daemon.js project-manager.js worker-manager.js test-stt.js /opt/squad/hub/
COPY public/ /opt/squad/hub/public/
RUN cd /opt/squad/hub && npm install --production
RUN mv /tmp/build-time.txt /opt/squad/hub/build-time.txt \
    && echo "$GIT_COMMIT" > /opt/squad/hub/git-commit.txt

# Entrypoint
COPY entrypoint.sh /entrypoint-hub.sh
RUN chmod +x /entrypoint-hub.sh

EXPOSE 3000

USER ubuntu

WORKDIR /home/ubuntu

ENTRYPOINT ["/entrypoint-hub.sh"]
