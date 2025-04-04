#!/bin/sh
set -e

echo "Entrypoint: Running as $(whoami)"

echo "Entrypoint: Ensuring /app/code is writable by user node..."
# Still need node to own the code dir for file writing by the app initially
chown -R node:node /app/code
echo "Entrypoint: /app/code ownership set."

# Check if we can ping the docker socket as the node user
# If not, fallback to running the command as root (less secure)
if gosu node docker ps > /dev/null 2>&1; then
    echo "Entrypoint: Docker socket accessible by user 'node'. Switching to user 'node'."
    COMMAND_USER="node"
else
    echo "Entrypoint: Docker socket NOT accessible by user 'node'. Running as 'root' (Warning: Less Secure)."
    COMMAND_USER="root"
fi

# Execute the main process (CMD) as the determined user
echo "Entrypoint: Executing command as '$COMMAND_USER': $@"
exec gosu ${COMMAND_USER} "$@"