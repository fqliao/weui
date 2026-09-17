FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 CHROME_EXECUTABLE_PATH=/opt/google/chrome/chrome PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.29.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/sample/package.json ./apps/sample/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps chrome firefox
COPY . .
RUN pnpm db:generate && pnpm build
RUN mkdir -p /app/.runtime/evidence && chown -R node:node /app /ms-playwright
USER node
EXPOSE 3100
CMD ["sh","-c","pnpm db:migrate && pnpm db:seed && pnpm start"]
