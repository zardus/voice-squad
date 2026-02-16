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

# Tmux socket directories for cross-container sharing
RUN mkdir -p /run/captain-tmux /run/workspace-tmux \
    && chown ubuntu:ubuntu /run/captain-tmux /run/workspace-tmux

# Voice server
COPY package.json server.js tmux-bridge.js stt.js tts.js status-daemon.js test-stt.js /opt/squad/voice/
COPY public/ /opt/squad/voice/public/
RUN cd /opt/squad/voice && npm install --production

# Entrypoint
COPY entrypoint.sh /entrypoint-voice.sh
RUN chmod +x /entrypoint-voice.sh

EXPOSE 3000

USER ubuntu

WORKDIR /home/ubuntu

ENTRYPOINT ["/entrypoint-voice.sh"]
