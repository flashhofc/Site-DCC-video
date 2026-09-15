const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Inicializa Banco de Dados SQLite
const db = new sqlite3.Database('./banco.db', (err) => {
    if (err) console.error("Erro ao abrir banco", err);
    else {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`);
            db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
            // Cria o Mestre padrão (flash)
            db.run(`INSERT OR IGNORE INTO users (username, password) VALUES ('flash', '22')`);
        });
    }
});

function registrarLog(msg) {
    const time = new Date().toLocaleTimeString('pt-BR');
    const fullMsg = `[${time}] ${msg}`;
    db.run(`INSERT INTO logs (message) VALUES (?)`, [fullMsg]);
    io.emit('new-log', fullMsg);
}

const rooms = {};

io.on('connection', (socket) => {
    // --- SISTEMA DE LOGIN COM CARGOS ---
    socket.on('login', ({ user, pass }) => {
        db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [user, pass], (err, row) => {
            if (row) {
                registrarLog(`Sistema acessado por: ${user}.`);
                // Define quem é o administrador supremo
                const role = (user === 'flash') ? 'master' : 'instrutor';
                socket.emit('login-success', { user, role });
            } else {
                socket.emit('login-failed');
            }
        });
    });

    socket.on('create-user', ({ adminUser, newUser, newPass }) => {
        if(adminUser !== 'flash') return socket.emit('user-created', { success: false, msg: 'Sem permissão!' });
        
        db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [newUser, newPass], function(err) {
            if(err) socket.emit('user-created', { success: false, msg: 'Usuário já existe!' });
            else {
                registrarLog(`Comandante ${adminUser} credenciou o instrutor ${newUser}`);
                socket.emit('user-created', { success: true, msg: 'Conta criada com sucesso!' });
            }
        });
    });

    socket.on('get-logs', (role) => {
        if(role !== 'master') return;
        db.all(`SELECT message FROM logs ORDER BY id DESC LIMIT 50`, [], (err, rows) => {
            if(rows) socket.emit('load-logs', rows.map(r => r.message));
        });
    });

    // --- SISTEMA DE SALAS ---
    socket.on('create-room', ({ videoUrl, videoName, adminName }) => {
        const roomId = Math.random().toString(36).substring(2, 9).toUpperCase();
        rooms[roomId] = { videoUrl, videoName, users: [], status: 'waiting', time: 0 };
        registrarLog(`Operação iniciada: ${videoName} (Sala: ${roomId}) por ${adminName}`);
        socket.emit('room-created', roomId);
    });

    socket.on('join-room', ({ roomId, isMod, name, fivemId }) => {
        socket.join(roomId);
        if (!rooms[roomId]) rooms[roomId] = { videoUrl: '', users: [] };
        
        const user = { id: socket.id, name, fivemId, isMod, focused: true, volume: 100 };
        rooms[roomId].users.push(user);

        if(!isMod) registrarLog(`Recruta ${name} (Passaporte: ${fivemId}) ingressou na base ${roomId}`);

        socket.emit('sync-video', { videoUrl: rooms[roomId].videoUrl, status: rooms[roomId].status });
        io.to(roomId).emit('update-users', rooms[roomId].users);
    });

    socket.on('update-status', ({ roomId, focused, volume }) => {
        if (!rooms[roomId]) return;
        const user = rooms[roomId].users.find(u => u.id === socket.id);
        if (user) {
            user.focused = focused; user.volume = volume;
            io.to(roomId).emit('update-users', rooms[roomId].users);
        }
    });

    socket.on('play-video', (roomId) => {
        if(rooms[roomId]) rooms[roomId].status = 'playing';
        io.to(roomId).emit('action-play');
    });

    socket.on('pause-video', (roomId) => {
        if(rooms[roomId]) rooms[roomId].status = 'paused';
        io.to(roomId).emit('action-pause');
    });

    socket.on('change-video', ({ roomId, newVideoUrl }) => {
        if(rooms[roomId]) {
            rooms[roomId].videoUrl = newVideoUrl;
            rooms[roomId].status = 'waiting';
            registrarLog(`Diretriz de vídeo alterada na base ${roomId}.`);
            io.to(roomId).emit('sync-video', { videoUrl: newVideoUrl, status: 'waiting' });
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            rooms[roomId].users = rooms[roomId].users.filter(u => u.id !== socket.id);
            io.to(roomId).emit('update-users', rooms[roomId].users);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SISTEMA TÁTICO ONLINE] Servidor rodando na porta ${PORT}`);
});