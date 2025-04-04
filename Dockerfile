# Use official Node.js image
FROM node:18

# Set DEBIAN_FRONTEND to noninteractive
ENV DEBIAN_FRONTEND=noninteractive

# Install prerequisites, Docker CLI, and gosu
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    gosu \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
 && echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
 && apt-get update && apt-get install -y --no-install-recommends \
    docker-ce-cli \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Argument to accept the host's docker group ID
ARG DOCKER_GID=999 # Default fallback

# ***** ADD THIS LINE TO DEBUG *****
RUN echo "====> DEBUG: Received DOCKER_GID build argument: '${DOCKER_GID}'"

# --- Simplified Group Handling (Keep as before) ---
RUN echo "Attempting to ensure group 'docker' exists with preferred GID=${DOCKER_GID}..." && \
    if getent group ${DOCKER_GID} > /dev/null 2>&1 && [ "$(getent group ${DOCKER_GID} | cut -d: -f1)" != "docker" ]; then \
        echo "Warning: GID ${DOCKER_GID} is already taken by group '$(getent group ${DOCKER_GID} | cut -d: -f1)'. Creating 'docker' group with a default GID instead."; \
        groupadd docker; \
    elif getent group docker > /dev/null 2>&1; then \
        echo "Group 'docker' already exists."; \
    else \
        groupadd -g ${DOCKER_GID} -o docker || groupadd docker; \
        echo "Attempted creation of group 'docker' with GID ${DOCKER_GID} (or default if GID was taken)."; \
    fi
RUN echo "Attempting to add user 'node' to group 'docker'..." && \
    if getent group docker > /dev/null 2>&1; then \
        usermod -aG docker node && echo "User 'node' added to group 'docker'."; \
    else \
        echo "Error: Group 'docker' not found. Cannot add user 'node'. Docker socket access will likely fail." && exit 1; \
    fi
# --- End of Simplified Group Handling ---

# ... (rest of the Dockerfile remains the same: pnpm install, copy entrypoint, copy app, mkdir code, expose, entrypoint, cmd) ...

# Install pnpm globally
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set the working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies using pnpm (as root)
RUN pnpm install --frozen-lockfile

# Copy entrypoint script and make it executable
COPY --chown=root:root entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Copy the rest of the application files and set ownership to node:node
COPY --chown=node:node . .

# Ensure the /app/code directory exists
RUN mkdir -p /app/code && chown node:node /app/code

# Expose port 3000
EXPOSE 3000

# Use the entrypoint script to fix permissions and run CMD as 'node' user
ENTRYPOINT ["entrypoint.sh"]

# Default command to be executed by the entrypoint script as the 'node' user
CMD ["node", "app.js"]