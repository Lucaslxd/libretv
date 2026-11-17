# 直播聚合服务（部署到 Render / Fly / 任意支持 Docker 的主机）
FROM node:20-alpine

WORKDIR /app

# 只带直播聚合板块，不引入 Next.js 主站
COPY app/live-agg ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "standalone.js"]
