FROM 315120000506.dkr.ecr.us-east-1.amazonaws.com/hotmart/alpine/node/24:alpine-3.22

ENV APP_NAME=reprocessador-guider
ENV CONTAINER_PORT=3001
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

COPY package.json package-lock.json ./

USER root
RUN npm ci --omit=dev
USER app

COPY --chown=app:app server.js sheets.js worker.js guider.js ./
COPY --chown=app:app public/ ./public/

CMD ["node", "server.js"]
