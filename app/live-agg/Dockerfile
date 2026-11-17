FROM node:20-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
# 设置后访问需要密码（建议在平台的环境变量里配置，不要写死在这里）
# ENV PASSWORD=changeme

EXPOSE 8080
CMD ["node", "standalone.js"]
