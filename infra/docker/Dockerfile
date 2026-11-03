FROM golang:1.27.3-bookworm AS windows-agent
WORKDIR /src
COPY agents/windows/go.mod agents/windows/go.sum ./
RUN go mod download
COPY agents/windows/ ./
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/wakebridge.exe ./cmd/wakebridge

FROM eclipse-temurin:21-jdk-jammy AS android-agent
ENV ANDROID_HOME=/android/sdk GRADLE_USER_HOME=/android/gradle
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fL https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip -o /tmp/android-tools.zip \
    && echo '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583  /tmp/android-tools.zip' | sha256sum -c - \
    && unzip -q /tmp/android-tools.zip -d /tmp/android-cli \
    && mkdir -p /android/sdk/cmdline-tools \
    && mv /tmp/android-cli/cmdline-tools /android/sdk/cmdline-tools/latest
RUN yes | /android/sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=/android/sdk 'platforms;android-37.0' 'build-tools;36.0.0' > /tmp/sdk-install.log
WORKDIR /src
COPY apps/agent-android/ ./
RUN chmod +x gradlew && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug

FROM node:24-bookworm-slim AS node-base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1

FROM node-base AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY apps apps
COPY packages packages
COPY --from=windows-agent /out/wakebridge.exe ./apps/web/public/downloads/wakebridge.exe
COPY --from=android-agent /src/app/build/outputs/apk/debug/app-debug.apk ./apps/web/public/downloads/wakebridge-android-debug.apk
RUN npm run db:generate && npm run build

FROM node-base AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/packages/shared ./packages/shared
USER node
WORKDIR /app/apps/api
EXPOSE 4100
CMD ["sh", "-c", "node ../../node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]

FROM node-base AS web
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
