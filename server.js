// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone');
const ExcelJS = require('exceljs');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app',
        'https://tuoportunidadeshoy.netlify.app',
        'http://localhost:8080',
        'http://127.0.0.1:5500',
        'http://localhost:3000',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // Límite de 50MB
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// Directorios y archivos para datos (ajustados a los nombres que usaste últimamente)
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'configuracion.json'); // Usar 'configuracion.json'
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');       // Usar 'numeros.json'
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');         // Usar 'ventas.json'
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horariosZulia.json'); // Usar 'horariosZulia.json'
const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes'); // Ruta de comprobantes ajustada

// Asegurar que los directorios existan
async function ensureDataAndComprobantesDirs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
}

// Funciones de lectura/escritura de JSON
async function readJsonFile(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await writeJsonFile(filePath, defaultValue); // Crea el archivo con el valor por defecto si no existe
            return defaultValue;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Cargar datos iniciales o crear si no existen
async function loadInitialData() {
    const configDefault = {
        sorteo_activo: true,
        fecha_sorteo: moment.tz("America/Caracas").format('YYYY-MM-DD'),
        precio_usd: 1.00,
        precio_bs: 38.00,
        zona_horaria: "America/Caracas",
        ultimo_numero_sorteo_correlativo: 0,
        ultimo_numero_ticket: 0
    };

    const numerosDefault = Array.from({ length: 100 }, (_, i) => ({
        numero: i,
        estado: 'disponible',
        comprador: null,
        fecha_compra: null,
        metodo_pago: null,
        referencia_pago: null
    }));

    const ventasDefault = [];
    const horariosZuliaDefault = [];

    await readJsonFile(CONFIG_FILE, configDefault);
    await readJsonFile(NUMEROS_FILE, numerosDefault);
    await readJsonFile(VENTAS_FILE, ventasDefault);
    await readJsonFile(HORARIOS_ZULIA_FILE, horariosZuliaDefault);

    // Servir archivos estáticos (comprobantes)
    app.use('/comprobantes', express.static(COMPROBANTES_DIR)); // Ruta de acceso público
}

// Configuración del transportador de Nodemailer
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Función para enviar correo de confirmación
async function enviarCorreoConfirmacion(compra) {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: compra.email,
            subject: `Confirmación de Compra de Números para la Rifa ${compra.correlativo_sorteo}`,
            html: `
                <p>Estimado/a ${compra.nombre_apellido},</p>
                <p>Gracias por tu compra en nuestra rifa. A continuación, los detalles de tu compra:</p>
                <ul>
                    <li><strong>Números Comprados:</strong> ${compra.numeros_comprados.map(n => String(n).padStart(2, '0')).join(', ')}</li>
                    <li><strong>Total USD:</strong> $${compra.total_usd}</li>
                    <li><strong>Total Bs:</strong> Bs ${compra.total_bs}</li>
                    <li><strong>Método de Pago:</strong> ${compra.metodo_pago}</li>
                    <li><strong>Referencia:</strong> ${compra.referencia_pago}</li>
                    <li><strong>Fecha de Compra:</strong> ${moment(compra.fecha_compra).tz("America/Caracas").format('DD/MM/YYYY hh:mm A')}</li>
                    <li><strong>Número de Ticket:</strong> ${String(compra.numero_ticket).padStart(5, '0')}</li>
                </ul>
                <p>Tu compra está registrada. ¡Mucha suerte en el sorteo!</p>
                <p>Saludos cordiales,<br>El equipo de la rifa</p>
            `,
        };
        await transporter.sendMail(mailOptions);
        console.log('Correo de confirmación enviado a:', compra.email);
    } catch (error) {
        console.error('Error al enviar correo de confirmación:', error);
    }
}


// --- RUTAS PARA EL FRONTEND DE USUARIO ---

// Ruta para obtener la configuración activa
app.get('/configuracion/activa', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        if (!config.sorteo_activo) {
            return res.status(404).json({ error: 'La plataforma está actualmente bloqueada.' });
        }
        res.json({
            sorteo_activo: config.sorteo_activo,
            fecha_sorteo: config.fecha_sorteo,
            precio_usd: config.precio_usd,
            precio_bs: config.precio_bs,
            zona_horaria: config.zona_horaria
        });
    } catch (error) {
        console.error('Error al obtener la configuración activa (frontend):', error);
        res.status(500).json({ error: 'Error interno del servidor al cargar la configuración.' });
    }
});

// Ruta para obtener todos los números y su estado
app.get('/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE);
        res.json(numeros);
    } catch (error) {
        console.error('Error al obtener números (frontend):', error);
        res.status(500).json({ error: 'Error interno del servidor al cargar los números.' });
    }
});

// Ruta para procesar la compra de números
app.post('/comprar', async (req, res) => {
    try {
        const { nombre_apellido, telefono, cedula, email, metodo_pago, referencia_pago, numeros_comprados, total_usd, total_bs } = req.body;
        const comprobante_pago = req.files ? req.files.comprobante_pago : null;

        if (!nombre_apellido || !telefono || !cedula || !email || !metodo_pago || !referencia_pago || !numeros_comprados || !comprobante_pago) {
            return res.status(400).json({ error: 'Faltan campos obligatorios para la compra.' });
        }

        let parsedNumeros = [];
        try {
            parsedNumeros = JSON.parse(numeros_comprados);
            if (!Array.isArray(parsedNumeros) || parsedNumeros.some(isNaN)) {
                throw new Error('Formato de números seleccionados inválido.');
            }
        } catch (parseError) {
            return res.status(400).json({ error: 'Formato de números seleccionados inválido.' });
        }

        const numeros = await readJsonFile(NUMEROS_FILE);
        const config = await readJsonFile(CONFIG_FILE);

        if (!config.sorteo_activo) {
            return res.status(403).json({ error: 'El sorteo no está activo en este momento.' });
        }

        const tomados = [];
        for (const num of parsedNumeros) {
            if (numeros[num] && numeros[num].estado === 'comprado') {
                tomados.push(num);
            }
        }

        if (tomados.length > 0) {
            return res.status(409).json({
                error: `Los siguientes números ya fueron comprados: ${tomados.map(n => String(n).padStart(2, '0')).join(', ')}.`,
                tomados: tomados
            });
        }

        const now = moment().tz(config.zona_horaria || "America/Caracas");
        const fechaCompra = now.toISOString();
        const timestamp = now.format('YYYYMMDDHHmmss');

        config.ultimo_numero_ticket = (config.ultimo_numero_ticket || 0) + 1;
        await writeJsonFile(CONFIG_FILE, config);
        const numeroTicket = config.ultimo_numero_ticket;

        let comprobanteFileName = '';
        let comprobantePath = '';
        let comprobanteUrl = '';

        if (comprobante_pago) {
            const fileExtension = path.extname(comprobante_pago.name);
            comprobanteFileName = `comprobante_${timestamp}_${cedula}${fileExtension}`;
            comprobantePath = path.join(COMPROBANTES_DIR, comprobanteFileName);
            await comprobante_pago.mv(comprobantePath);
            comprobanteUrl = `${API_BASE_URL}/comprobantes/${comprobanteFileName}`; // Ruta pública
        }

        const newPurchase = {
            id: Date.now(),
            nombre_apellido,
            telefono,
            cedula,
            email,
            numeros_comprados: parsedNumeros,
            total_usd: parseFloat(total_usd),
            total_bs: parseFloat(total_bs),
            metodo_pago,
            referencia_pago,
            fecha_compra: fechaCompra,
            estado: 'pendiente',
            url_comprobante: comprobanteUrl, // Usar 'url_comprobante' para compatibilidad con ventas.json
            numero_ticket: numeroTicket,
            correlativo_sorteo: config.ultimo_numero_sorteo_correlativo || 0
        };

        const ventas = await readJsonFile(VENTAS_FILE); // Usar VENTAS_FILE
        ventas.push(newPurchase);
        await writeJsonFile(VENTAS_FILE, ventas);

        for (const num of parsedNumeros) {
            if (numeros[num]) {
                numeros[num].estado = 'comprado';
                numeros[num].comprador = nombre_apellido;
                numeros[num].fecha_compra = fechaCompra;
                numeros[num].metodo_pago = metodo_pago;
                numeros[num].referencia_pago = referencia_pago;
                numeros[num].id_compra = newPurchase.id;
                numeros[num].numero_ticket = numeroTicket;
                numeros[num].correlativo_sorteo = config.ultimo_numero_sorteo_correlativo || 0;
            }
        }
        await writeJsonFile(NUMEROS_FILE, numeros);

        enviarCorreoConfirmacion(newPurchase);

        res.status(201).json({ message: 'Compra realizada con éxito', compra: newPurchase });

    } catch (error) {
        console.error('Error al procesar la compra:', error);
        res.status(500).json({ error: 'Error interno del servidor al procesar la compra.', details: error.message });
    }
});


// --- RUTAS PARA EL PANEL DE ADMINISTRACIÓN (con prefijo /api/) ---

// Ruta para obtener la configuración (Admin)
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para actualizar la configuración (Admin)
app.post('/api/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        let currentConfig = await readJsonFile(CONFIG_FILE);
        Object.assign(currentConfig, newConfig);
        await writeJsonFile(CONFIG_FILE, currentConfig);
        res.json({ message: 'Configuración actualizada con éxito', config: currentConfig });
    } catch (error) {
        console.error('Error al actualizar configuración (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para obtener todas las ventas (Admin)
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE); // Usar VENTAS_FILE
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para obtener horarios del Zulia (Admin)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        console.error('Error al obtener horarios del Zulia (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para agregar un horario del Zulia (Admin)
app.post('/api/horarios-zulia', async (req, res) => {
    try {
        const { horario } = req.body;
        if (!horario) {
            return res.status(400).json({ error: 'Horario es obligatorio.' });
        }
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        if (!horarios.includes(horario)) {
            horarios.push(horario);
            await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
            return res.status(201).json({ message: 'Horario agregado con éxito', horarios });
        }
        res.status(409).json({ error: 'El horario ya existe.' });
    } catch (error) {
        console.error('Error al agregar horario del Zulia (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para eliminar un horario del Zulia (Admin)
app.post('/api/horarios-zulia/eliminar', async (req, res) => {
    try {
        const { horario } = req.body;
        if (!horario) {
            return res.status(400).json({ error: 'Horario es obligatorio.' });
        }
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        const initialLength = horarios.length;
        horarios = horarios.filter(h => h !== horario);
        if (horarios.length < initialLength) {
            await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
            return res.json({ message: 'Horario eliminado con éxito', horarios });
        }
        res.status(404).json({ error: 'Horario no encontrado.' });
    } catch (error) {
        console.error('Error al eliminar horario del Zulia (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// Ruta para reiniciar la rifa (Admin)
app.post('/api/reiniciar-rifa', async (req, res) => {
    try {
        const numerosDefault = Array.from({ length: 100 }, (_, i) => ({
            numero: i,
            estado: 'disponible',
            comprador: null,
            fecha_compra: null,
            metodo_pago: null,
            referencia_pago: null
        }));
        await writeJsonFile(NUMEROS_FILE, numerosDefault); // Reinicia los números

        let config = await readJsonFile(CONFIG_FILE);
        config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
        config.ultimo_numero_ticket = 0;
        config.fecha_sorteo = moment().tz(config.zona_horaria || "America/Caracas").add(1, 'days').format('YYYY-MM-DD');
        await writeJsonFile(CONFIG_FILE, config);

        res.json({ message: 'Rifa reiniciada con éxito. Números disponibles y correlativo de sorteo actualizado.', config });
    } catch (error) {
        console.error('Error al reiniciar rifa (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor al reiniciar la rifa.' });
    }
});

// Ruta para exportar ventas a Excel (Admin)
app.get('/api/exportar-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE); // Usar VENTAS_FILE
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas de Rifa');

        worksheet.columns = [
            { header: 'ID Compra', key: 'id', width: 10 },
            { header: 'Ticket', key: 'numero_ticket', width: 10 },
            { header: 'Sorteo Correlativo', key: 'correlativo_sorteo', width: 15 },
            { header: 'Fecha Compra', key: 'fecha_compra_local', width: 20 },
            { header: 'Nombre Apellido', key: 'nombre_apellido', width: 30 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Números Comprados', key: 'numeros_comprados_str', width: 30 },
            { header: 'Total USD', key: 'total_usd', width: 15 },
            { header: 'Total Bs', key: 'total_bs', width: 15 },
            { header: 'Método Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Estado', key: 'estado', width: 15 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 40 } // Ajustado a 'url_comprobante'
        ];

        const config = await readJsonFile(CONFIG_FILE); // Cargar config para zona horaria

        ventas.forEach(p => {
            const fechaLocal = moment(p.fecha_compra).tz(config.zona_horaria || "America/Caracas").format('DD/MM/YYYY hh:mm A');
            worksheet.addRow({
                id: p.id,
                numero_ticket: String(p.numero_ticket).padStart(5, '0'),
                correlativo_sorteo: p.correlativo_sorteo,
                fecha_compra_local: fechaLocal,
                nombre_apellido: p.nombre_apellido,
                cedula: p.cedula,
                telefono: p.telefono,
                email: p.email,
                numeros_comprados_str: p.numeros_comprados.map(n => String(n).padStart(2, '0')).join(', '),
                total_usd: p.total_usd,
                total_bs: p.total_bs,
                metodo_pago: p.metodo_pago,
                referencia_pago: p.referencia_pago,
                estado: p.estado,
                url_comprobante: p.url_comprobante
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'ventas_rifa.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar a Excel (Admin):', error);
        res.status(500).json({ error: 'Error interno del servidor al exportar a Excel.' });
    }
});


// Tarea programada para cortar ventas y reiniciar números a medianoche
cron.schedule('0 0 * * *', async () => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        const now = moment().tz(config.zona_horaria || "America/Caracas");
        const todayFormatted = now.format('YYYY-MM-DD');
        const currentDrawDate = moment(config.fecha_sorteo).format('YYYY-MM-DD');

        console.log(`Ejecutando tarea programada a las ${now.format('HH:mm:ss')}.`);
        console.log(`Fecha actual (zona horaria del servidor): ${todayFormatted}`);
        console.log(`Fecha de sorteo configurada: ${currentDrawDate}`);

        if (moment(currentDrawDate).isSameOrBefore(todayFormatted, 'day')) {
            console.log(`Sorteo de fecha ${currentDrawDate} ha terminado o es hoy. Reiniciando números y actualizando la fecha del próximo sorteo.`);
            const numerosDefault = Array.from({ length: 100 }, (_, i) => ({
                numero: i,
                estado: 'disponible',
                comprador: null,
                fecha_compra: null,
                metodo_pago: null,
                referencia_pago: null
            }));
            await writeJsonFile(NUMEROS_FILE, numerosDefault);

            config.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD');
            config.ultimo_numero_sorteo_correlativo = (config.ultimo_numero_sorteo_correlativo || 0) + 1;
            config.ultimo_numero_ticket = 0;
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.ultimo_numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas"
});


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
            console.log(`Plataforma de usuario disponible en: https://tuoportunidadeshoy.netlify.app`);
        });
    }).catch(error => {
        console.error('Error al cargar datos iniciales o iniciar el servidor:', error);
    });
}).catch(error => {
    console.error('Error al asegurar directorios:', error);
});