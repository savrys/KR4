const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_ID = process.env.SERVER_ID || 'default';

app.use(express.json());

// ---------- Корневой маршрут для проверки ----------
app.get('/', (req, res) => {
  res.json({ message: 'Balancer is working', server: SERVER_ID });
});

// ---------- Повторное подключение с retry ----------
async function connectWithRetry(connectFn, name, retries = 10, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      await connectFn();
      console.log(`${name} connected successfully`);
      return;
    } catch (err) {
      console.error(`${name} connection attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ---------- PostgreSQL (Sequelize) ----------
const sequelize = new Sequelize(
  process.env.POSTGRES_DB || 'mydatabase',
  process.env.POSTGRES_USER || 'postgres',
  process.env.POSTGRES_PASSWORD || 'password',
  {
    host: process.env.POSTGRES_HOST || 'postgres',
    dialect: 'postgres',
  }
);

const UserSQL = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  first_name: { type: DataTypes.STRING, allowNull: false },
  last_name: { type: DataTypes.STRING, allowNull: false },
  age: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// ---------- MongoDB (Mongoose) ----------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/usersdb';

async function connectMongo() {
  await mongoose.connect(MONGO_URI);
}

const userSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name:  { type: String, required: true },
  age:        { type: Number, required: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

const UserMongo = mongoose.model('User', userSchema);

// ---------- Redis ----------
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://redis:6379'
});

async function connectRedis() {
  await redisClient.connect();
}

// ---------- Middleware кэширования ----------
async function cacheMiddleware(req, res, next) {
  try {
    if (!redisClient.isOpen) return next();
    const key = `users:${req.method}:${req.originalUrl}`;
    const cached = await redisClient.get(key);
    if (cached) {
      return res.json({ source: 'cache', server: SERVER_ID, data: JSON.parse(cached) });
    }
    req.cacheKey = key;
    next();
  } catch (err) {
    console.error('Cache read error:', err);
    next();
  }
}

async function saveToCache(key, data, ttl = 60) {
  try {
    if (!redisClient.isOpen) return;
    await redisClient.set(key, JSON.stringify(data), { EX: ttl });
  } catch (err) {
    console.error('Cache save error:', err);
  }
}

async function invalidateUsersCache() {
  try {
    if (!redisClient.isOpen) return;
    const keys = await redisClient.keys('users:*');
    if (keys.length > 0) await redisClient.del(keys);
  } catch (err) {
    console.error('Cache invalidate error:', err);
  }
}

// ---------- CRUD API ----------

// Создание пользователя
app.post('/api/users', async (req, res) => {
  try {
    const { first_name, last_name, age } = req.body;
    if (!first_name || !last_name || !age) {
      return res.status(400).json({ error: 'first_name, last_name, age are required' });
    }
    const userSQL = await UserSQL.create({ first_name, last_name, age });
    try { await UserMongo.create({ first_name, last_name, age }); } catch(e) { console.error('Mongo create error:', e.message); }
    await invalidateUsersCache();
    res.status(201).json({ source: 'server', server: SERVER_ID, data: userSQL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Получение всех пользователей (с кэшированием)
app.get('/api/users', cacheMiddleware, async (req, res) => {
  try {
    const users = await UserSQL.findAll({ order: [['id', 'ASC']] });
    await saveToCache(req.cacheKey, users);
    res.json({ source: 'server', server: SERVER_ID, data: users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение пользователя по ID (с кэшированием)
app.get('/api/users/:id', cacheMiddleware, async (req, res) => {
  try {
    const user = await UserSQL.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await saveToCache(req.cacheKey, user);
    res.json({ source: 'server', server: SERVER_ID, data: user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление пользователя
app.patch('/api/users/:id', async (req, res) => {
  try {
    const userSQL = await UserSQL.findByPk(req.params.id);
    if (!userSQL) return res.status(404).json({ error: 'User not found' });
    await userSQL.update(req.body);
    await invalidateUsersCache();
    res.json({ source: 'server', server: SERVER_ID, data: userSQL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Удаление пользователя
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userSQL = await UserSQL.findByPk(req.params.id);
    if (!userSQL) return res.status(404).json({ error: 'User not found' });
    await userSQL.destroy();
    await invalidateUsersCache();
    res.json({ source: 'server', server: SERVER_ID, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health-check для Nginx
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: SERVER_ID });
});

// ---------- Инициализация и запуск ----------
async function start() {
  try {
    // Ждём PostgreSQL
    await connectWithRetry(
      async () => { await sequelize.authenticate(); },
      'PostgreSQL'
    );
    // force: false - не пересоздавать таблицу, если она уже есть
    // sync() без параметров работает как "создать, если не существует"
    await UserSQL.sync();
    console.log('PostgreSQL connected and synced');

    // Ждём MongoDB
    await connectWithRetry(connectMongo, 'MongoDB');
    console.log('MongoDB connected');

    // Ждём Redis
    await connectWithRetry(connectRedis, 'Redis');
    console.log('Redis connected');

    // Запускаем сервер
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server ${SERVER_ID} running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Startup error after retries:', err);
    process.exit(1);
  }
}

start();