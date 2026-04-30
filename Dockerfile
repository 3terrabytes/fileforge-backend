FROM node:20-slim

# Install FFmpeg, LibreOffice, ImageMagick, poppler-utils
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libreoffice \
    imagemagick \
    poppler-utils \
    --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Fix ImageMagick PDF policy
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml || true

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p uploads outputs

EXPOSE 3001

CMD ["node", "server.js"]
