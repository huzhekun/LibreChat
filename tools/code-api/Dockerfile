FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash python3 gcc g++ make openjdk-17-jdk-headless golang rustc cargo php r-base gfortran ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY tools/code-api/package.json ./package.json
RUN npm install --omit=dev
COPY tools/code-api/src ./src

ENV PORT=3085
ENV DATA_ROOT=/var/lib/librechat-code-api

VOLUME ["/var/lib/librechat-code-api"]
EXPOSE 3085
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3085/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "run", "start"]
