FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    tmux \
    ca-certificates \
    gnupg \
    sudo \
    jq \
    procps \
    locales \
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

# Shared sockets directory for cross-container sharing
RUN mkdir -p /run/squad-sockets/captain-tmux /run/squad-sockets/workspace-tmux \
    && chown -R ubuntu:ubuntu /run/squad-sockets

# Build metadata
ARG GIT_COMMIT=unknown
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > /tmp/build-time.txt

# Voice server
COPY package.json server.js tmux-bridge.js stt.js tts.js status-daemon.js test-stt.js /opt/squad/voice/
COPY public/ /opt/squad/voice/public/
RUN cd /opt/squad/voice && npm install --production
RUN mv /tmp/build-time.txt /opt/squad/voice/build-time.txt \
    && echo "$GIT_COMMIT" > /opt/squad/voice/git-commit.txt

# Entrypoint
COPY entrypoint.sh /entrypoint-voice.sh
RUN chmod +x /entrypoint-voice.sh

EXPOSE 3000

USER ubuntu

WORKDIR /home/ubuntu

ENTRYPOINT ["/entrypoint-voice.sh"]
