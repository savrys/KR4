#!/bin/bash

pause() {
  echo ""
  read -p "Нажмите Enter для продолжения..."
}

echo "Все контейнеры:"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
pause

echo "Nginx (порт 80):"
for i in 1 2; do
  echo "  Запрос $i -> $(curl -s http://localhost/ | jq -r '.server')"
done

echo ""
echo "HAProxy (порт 8080):"
for i in 1 2; do
  echo "  Запрос $i -> $(curl -s http://localhost:8080/ | jq -r '.server')"
done
pause

echo "Создание пользователя:"
RESULT=$(curl -s -X POST http://localhost/api/users \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Сергей","last_name":"Сергеев","age":30}')
echo "$RESULT" | jq
USER_ID=$(echo "$RESULT" | jq -r '.data.id')
pause

echo "PostgreSQL:"
docker compose exec -T postgres psql -U postgres -d mydatabase -c "SELECT id, first_name, last_name, age FROM users;"

echo ""
echo "MongoDB:"
docker compose exec -T mongo mongosh --quiet usersdb --eval "db.users.find().pretty()"
pause

echo "GET /api/users (первый запрос):"
curl -s http://localhost/api/users | jq '{source, server}'
echo "GET /api/users (второй запрос, из кэша):"
curl -s http://localhost/api/users | jq '{source, server}'

echo ""
echo "GET /api/users/$USER_ID (первый запрос):"
curl -s "http://localhost/api/users/$USER_ID" | jq '{source, server}'
echo "GET /api/users/$USER_ID (второй запрос, из кэша):"
curl -s "http://localhost/api/users/$USER_ID" | jq '{source, server}'

echo ""
echo "Ключи Redis:"
docker compose exec -T redis redis-cli KEYS "users:*"
pause

echo "Обновление пользователя (сброс кэша):"
curl -s -X PATCH "http://localhost/api/users/$USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"age":99}' | jq '{source, server, data: {id: .data.id, age: .data.age}}'
echo "Запрос после обновления (source=server):"
curl -s "http://localhost/api/users/$USER_ID" | jq '{source, server}'
pause

echo "Удаление пользователя:"
curl -s -X DELETE "http://localhost/api/users/$USER_ID" | jq
echo "Проверка после удаления:"
curl -s "http://localhost/api/users/$USER_ID" | jq
pause

echo "Создание тестового пользователя:"
TEST_ID=$(curl -s -X POST http://localhost/api/users \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Тест","last_name":"Тестов","age":50}' | jq -r '.data.id')
echo "ID: $TEST_ID"

echo ""
echo "Остановка backend-1:"
docker compose stop backend1
echo "Запросы без backend-1:"
for i in 1 2 3; do
  echo "  -> $(curl -s http://localhost/api/users | jq -r '.server')"
done

echo ""
echo "Запуск backend-1:"
docker compose start backend1
sleep 5
echo "Запросы после восстановления:"
for i in 1 2; do
  echo "  -> $(curl -s http://localhost/ | jq -r '.server')"
done
