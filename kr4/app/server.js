const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_ID = process.env.SERVER_ID || 'default';

app.use(express.json());

// ---------- Корневой маршрут ----------
app.get('/', (req, res) => {
  res.json({ message: 'Balancer is working', server: SERVER_ID });
});

// ---------- Retry подключения ----------
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

// ---------- PostgreSQL (Практика 19) ----------
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
  first_name: { type: DataTypes.STRING, allowNull: false },
  last_name: { type: DataTypes.STRING, allowNull: false },
  age: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// ---------- MongoDB (Практика 20) — ОСНОВНОЕ ХРАНИЛИЩЕ ДЛЯ ЧТЕНИЯ ----------
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

// ---------- Redis (Практика 21) ----------
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
    const key = `users:${req.originalUrl}`;
    const cached = await redisClient.get(key);
    if (cached) {
      console.log(`Cache HIT: ${key}`);
      return res.json({ source: 'cache', server: SERVER_ID, data: JSON.parse(cached) });
    }
    console.log(`Cache MISS: ${key}`);
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
    console.log(`Saved to cache: ${key}`);
  } catch (err) {
    console.error('Cache save error:', err);
  }
}

async function invalidateUsersCache() {
  try {
    if (!redisClient.isOpen) return;
    const keys = await redisClient.keys('users:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`Cache invalidated: ${keys.length} keys`);
    }
  } catch (err) {
    console.error('Cache invalidate error:', err);
  }
}

// ========== CRUD API ==========
// ЧТЕНИЕ — из MongoDB (Практика 20)
// ЗАПИСЬ — в PostgreSQL + MongoDB (Практика 19 + 20)

// POST — Создание (пишем в обе БД)
app.post('/api/users', async (req, res) => {
  try {
    const { first_name, last_name, age } = req.body;
    if (!first_name || !last_name || !age) {
      return res.status(400).json({ error: 'first_name, last_name, age are required' });
    }
    // Пишем в PostgreSQL
    const userSQL = await UserSQL.create({ first_name, last_name, age });
    // Пишем в MongoDB (основное хранилище)
    const userMongo = await UserMongo.create({ first_name, last_name, age });
    // Связываем ID
    await UserSQL.update({ mongo_id: userMongo._id.toString() }, { where: { id: userSQL.id } });
    await invalidateUsersCache();
    res.status(201).json({
      source: 'server',
      server: SERVER_ID,
      data: {
        id: userMongo._id,
        first_name: userMongo.first_name,
        last_name: userMongo.last_name,
        age: userMongo.age,
        created_at: userMongo.created_at,
        updated_at: userMongo.updated_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET — Список пользователей (из MongoDB + кэш Redis)
app.get('/api/users', cacheMiddleware, async (req, res) => {
  try {
    const users = await UserMongo.find().sort({ created_at: -1 });
    const data = users.map(u => ({
      id: u._id,
      first_name: u.first_name,
      last_name: u.last_name,
      age: u.age,
      created_at: u.created_at,
      updated_at: u.updated_at
    }));
    await saveToCache(req.cacheKey, data);
    res.json({ source: 'server', server: SERVER_ID, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET — Пользователь по ID (из MongoDB + кэш Redis)
app.get('/api/users/:id', cacheMiddleware, async (req, res) => {
  try {
    const user = await UserMongo.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const data = {
      id: user._id,
      first_name: user.first_name,
      last_name: user.last_name,
      age: user.age,
      created_at: user.created_at,
      updated_at: user.updated_at
    };
    await saveToCache(req.cacheKey, data);
    res.json({ source: 'server', server: SERVER_ID, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH — Обновление (MongoDB + PostgreSQL)
app.patch('/api/users/:id', async (req, res) => {
  try {
    const userMongo = await UserMongo.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!userMongo) return res.status(404).json({ error: 'User not found' });
    // Синхронизируем с PostgreSQL
    const userSQL = await UserSQL.findOne({ where: { mongo_id: req.params.id } });
    if (userSQL) {
      await userSQL.update(req.body);
    }
    await invalidateUsersCache();
    res.json({
      source: 'server',
      server: SERVER_ID,
      data: {
        id: userMongo._id,
        first_name: userMongo.first_name,
        last_name: userMongo.last_name,
        age: userMongo.age,
        created_at: userMongo.created_at,
        updated_at: userMongo.updated_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE — Удаление (MongoDB + PostgreSQL)
app.delete('/api/users/:id', async (req, res) => {
  try {
    const userMongo = await UserMongo.findByIdAndDelete(req.params.id);
    if (!userMongo) return res.status(404).json({ error: 'User not found' });
    // Удаляем из PostgreSQL
    const userSQL = await UserSQL.findOne({ where: { mongo_id: req.params.id } });
    if (userSQL) {
      await userSQL.destroy();
    }
    await invalidateUsersCache();
    res.json({ source: 'server', server: SERVER_ID, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health-check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: SERVER_ID });
});

// ---------- Запуск ----------
async function start() {
  try {
    await connectWithRetry(
      async () => { await sequelize.authenticate(); },
      'PostgreSQL'
    );
    await UserSQL.sync();
    // Добавляем колонку mongo_id если её нет
    try {
      await sequelize.getQueryInterface().addColumn('users', 'mongo_id', {
        type: DataTypes.STRING,
        allowNull: true
      });
    } catch (e) {
      // Колонка уже существует
    }
    console.log('PostgreSQL connected and synced');

    await connectWithRetry(connectMongo, 'MongoDB');
    console.log('MongoDB connected');

    await connectWithRetry(connectRedis, 'Redis');
    console.log('Redis connected');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server ${SERVER_ID} running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Startup error after retries:', err);
    process.exit(1);
  }
}

start();