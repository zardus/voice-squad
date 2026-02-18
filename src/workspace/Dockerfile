FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Core tools + Nix
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gh \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    sudo \
    jq \
    locales \
    nix-bin \
    && rm -rf /var/lib/apt/lists/*

# Generate UTF-8 locale (required for Unicode in tmux / Claude Code UI)
RUN locale-gen en_US.UTF-8

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color

# Configure nix for single-user mode (no daemon, no systemd in Docker)
RUN chown -R ubuntu:ubuntu /nix \
    && mkdir -p /etc/nix \
    && printf 'sandbox = false\nexperimental-features = nix-command flakes\n' > /etc/nix/nix.conf

ENV NIX_REMOTE="" \
    NIX_PATH="nixpkgs=channel:nixpkgs-unstable"

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

# Node.js (for workers that need it)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python + pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx

# Useful Python packages
RUN pip3 install --break-system-packages --no-cache-dir \
    requests \
    httpx \
    beautifulsoup4 \
    lxml \
    pyyaml \
    toml \
    python-dotenv \
    click \
    rich \
    pydantic \
    numpy \
    pandas \
    scipy \
    matplotlib \
    jinja2 \
    pytest \
    black \
    ruff \
    mypy \
    ipython

# cloudflared (may be useful for worker tasks)
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture) \
    -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# Claude Code + Codex (workers run here)
RUN npm install -g @anthropic-ai/claude-code @openai/codex@0.98.0

# qrcode-terminal for showing voice URL QR codes
RUN npm install -g qrcode-terminal

# Set up ubuntu user (already exists in 24.04 base image)
RUN usermod -aG docker ubuntu \
    && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Shared sockets directory for cross-container sharing
RUN mkdir -p /run/squad-sockets/workspace-tmux \
    && chown -R ubuntu:ubuntu /run/squad-sockets

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER ubuntu

WORKDIR /home/ubuntu

ENTRYPOINT ["/entrypoint.sh"]
