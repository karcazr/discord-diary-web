FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATABASE_PATH=/data/diary.sqlite3
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py storage.py ./
COPY docs ./docs
RUN useradd --system --uid 10001 diary && install -d -o diary -g diary /data
USER diary
VOLUME ["/data"]
EXPOSE 8000
CMD ["waitress-serve", "--listen=0.0.0.0:8000", "--call", "server:create_app"]
