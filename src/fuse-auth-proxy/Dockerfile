FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    fuse3 \
    libfuse2 \
    sudo \
    socat \
    && rm -rf /var/lib/apt/lists/*

# Install fusepy
RUN pip3 install --break-system-packages --no-cache-dir fusepy

# Allow non-root FUSE mounts
RUN echo "user_allow_other" >> /etc/fuse.conf

# Set up ubuntu user
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Create runtime directories
RUN mkdir -p /run/fuse-auth-proxy \
    && chown ubuntu:ubuntu /run/fuse-auth-proxy

COPY fuse_auth_proxy.py /opt/squad/fuse-auth-proxy/fuse_auth_proxy.py
COPY fuse-auth-register.sh /opt/squad/fuse-auth-proxy/fuse-auth-register.sh
RUN chmod +x /opt/squad/fuse-auth-proxy/fuse_auth_proxy.py \
    /opt/squad/fuse-auth-proxy/fuse-auth-register.sh

COPY entrypoint.sh /entrypoint-fuse-auth-proxy.sh
RUN chmod +x /entrypoint-fuse-auth-proxy.sh

USER ubuntu

ENTRYPOINT ["/entrypoint-fuse-auth-proxy.sh"]
