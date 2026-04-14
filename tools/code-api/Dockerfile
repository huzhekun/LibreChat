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

CMD ["npm", "run", "start"]
