# 只有一支 index.js 和一個相依套件，image 越小啟動越快。
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
