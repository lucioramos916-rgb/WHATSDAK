const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const multer = require('multer'); // <--- NUEVO: Para procesar los audios subidos

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// <--- NUEVO: Configurar dónde se guardarán temporalmente los audios
const upload = multer({ dest: 'uploads/' });

// Middleware para entender JSON en las peticiones HTTP y cabeceras estrictas para el Service Worker
app.use(express.json());
app.use(express.static(__dirname, {
    setHeaders: (res, path) => {
        if (path.endsWith('sw.js')) {
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        }
    }
}));

// <--- NUEVO: Permitir que el navegador pueda reproducir los audios de la carpeta uploads
app.use('/uploads', express.static('uploads'));
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- CONFIGURACIÓN DE WEB PUSH ---
const publicVapidKey = 'BJMPG84wwiQAVAEAl5a2la4cbpssS6ODOyIsLeh-ea6KhoGiXEXWGw22SxyE6hc6SlO9SQGG9-TV7VDIWJDZojg';
const privateVapidKey = 'AJtSgztsN7J0lFNLNUvvC7H-F_pU8IRzr03pn-ShXmc';

webpush.setVapidDetails(
    'mailto:tu-correo@example.com',
    publicVapidKey,
    privateVapidKey
);

// Almacén temporal en memoria para las suscripciones de los usuarios
const subscriptions = {};

// Ruta HTTP para recibir la suscripción del navegador del usuario
app.post('/subscribe', (req, res) => {
    const { user, subscription } = req.body;
    if (user) {
        const userName = user.trim().toLowerCase();
        subscriptions[userName] = subscription;
        console.log(`[SUBSCRIPCIÓN] Guardada correctamente para: ${userName}`);
        res.status(201).json({});
    } else {
        res.status(400).json({ error: 'Usuario no proporcionado' });
    }
});

// <--- NUEVO: RUTA HTTP PARA RECIBIR LA NOTA DE VOZ DESDE EL CLIENTE
app.post('/upload-voice', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió audio' });

    const audioUrl = `/uploads/${req.file.filename}`;
    const user = req.body.user;

    // Transmitir la nota de voz a todos los conectados mediante WebSockets
    io.emit('chat message', {
        user: user,
        audioUrl: audioUrl,
        isAudio: true
    });

    res.json({ success: true, audioUrl: audioUrl });
});

async function translateText(text, sourceLang, targetLang) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        const data = await response.json();
        return data[0][0][0];
    } catch (error) {
        console.error("Error traduciendo:", error);
        return text;
    }
}

io.on('connection', (socket) => {
    console.log('¡Un dispositivo se ha conectado!');

    socket.on('chat message', async (data) => {
        // <--- NUEVO: Si es un audio, no hacemos nada aquí porque ya se emitió desde el /upload-voice
        if (data.isAudio) return;

        const { user, text } = data;
        const userName = user.trim().toLowerCase();
        
        let sourceLang, targetLang;
        if (userName === 'lucio') {
            sourceLang = 'en';
            targetLang = 'es';
        } else {
            sourceLang = 'es';
            targetLang = 'en';
        }

        const translatedText = await translateText(text, sourceLang, targetLang);

        const finalMessage = {
            user: data.user,
            text_es: sourceLang === 'es' ? text : translatedText,
            text_en: sourceLang === 'en' ? text : translatedText
        };

        // 1. Enviar el mensaje por WebSockets en tiempo real
        io.emit('chat message', finalMessage);

        // 2. Diagnóstico en consola para ver quién manda y a quién se intenta notificar
        console.log(`\n--- NUEVO MENSAJE de [${userName}] ---`);
        console.log("Suscripciones activas en el server:", Object.keys(subscriptions));

        // 3. Enviar Notificación Push al OTRO usuario
        for (const [subUser, subData] of Object.entries(subscriptions)) {
            if (subUser !== userName) {
                console.log(`-> Intentando enviar notificación push a: ${subUser}`);
                
                const textForRecipient = subUser === 'lucio' ? finalMessage.text_en : finalMessage.text_es;
                
                const payload = JSON.stringify({
                    title: `Nuevo mensaje de ${user}`,
                    body: textForRecipient
                });

                webpush.sendNotification(subData, payload)
                    .then(() => console.log(`-> ¡Push enviada con éxito a ${subUser}!`))
                    .catch(err => console.error(`-> Error enviando push a ${subUser}:`, err));
            }
        }
    });

    socket.on('typing', (data) => {
        socket.broadcast.emit('typing', data);
    });

    socket.on('stop typing', (data) => {
        socket.broadcast.emit('stop typing', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});