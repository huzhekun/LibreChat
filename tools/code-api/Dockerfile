FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash python3 gcc g++ make openjdk-17-jdk-headless golang rustc cargo php r-base gfortran ca-certificates bubblewrap \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 sandbox && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin sandbox

WORKDIR /app
COPY tools/code-api/package.json ./package.json
RUN npm install --omit=dev
COPY tools/code-api/src ./src
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/code-landlock ./src/code-landlock.c

ENV PORT=3085
ENV DATA_ROOT=/var/lib/librechat-code-api
ENV SANDBOX_UID=10001
ENV SANDBOX_GID=10001
ENV SANDBOX_NETWORK_MODE=isolated
ENV SANDBOX_BACKEND=landlock

VOLUME ["/var/lib/librechat-code-api"]
EXPOSE 3085
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3085/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "run", "start"]
