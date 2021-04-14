FROM node:12.15.0

WORKDIR /app

ADD . /app

EXPOSE 8000
RUN npm i