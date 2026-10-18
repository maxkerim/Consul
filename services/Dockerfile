FROM python:3.12-slim
WORKDIR /app
# Сначала зависимости: этот слой кэшируется, пока requirements.txt не менялся
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
CMD ["python", "app.py"]
