// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');

// Cargar variables de entorno al inicio. Si no hay .env, no pasa nada si las credenciales de correo están en JSON.
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- Configuración de CORS ---
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app', // Tu panel de cliente
        // Para desarrollo local, puedes añadir:
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
    limits: { fileSize: 50 * 1024 * 1024 },
    debug: false,
    createParentPath: true
}));

// Servir archivos estáticos desde la carpeta 'uploads' (para los comprobantes subidos)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Rutas de Archivos de Configuración y Datos Locales (JSON) ---
const CONFIG_PATH = path.join(__dirname, 'configuracion.json'); // <-- ¡NOMBRE DE ARCHIVO CORREGIDO AQUÍ!
const NUMEROS_PATH = path.join(__dirname, 'numeros.json');
const VENTAS_PATH = path.join(__dirname, 'ventas.json');
const CORTES_PATH = path.join(__dirname, 'cortes.json');
const HORARIOS_ZULIA_PATH = path.join(__dirname, 'horarios-zulia.json');

// --- Funciones de Utilidad para Lectura/Escritura de Archivos JSON ---
async function leerArchivo(filePath, defaultValue = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        try {
            return JSON.parse(data);
        } catch (parseError) {
            console.warn(`Error al parsear el archivo ${filePath}, usando valor por defecto.`, parseError);
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
            return defaultValue;
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo ${filePath} no encontrado. Creando con valor por defecto.`);
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
            return defaultValue;
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw new Error(`Fallo al leer o inicializar el archivo ${filePath}.`);
    }
}

async function escribirArchivo(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir en el archivo ${filePath}:`, error);
        throw new Error(`Fallo al escribir en el archivo ${filePath}.`);
    }
}

// --- Configuración del Transportador de Correo Electrónico (Nodemailer) ---
// Declaramos la variable transporter aquí, pero la inicializamos más tarde
let transporter; 

// Nueva función asíncrona para inicializar el transporter
async function initializeTransporter() {
    try {
        // Leemos la configuración global, que contiene la sección de mail_config
        const config = await leerArchivo(CONFIG_PATH, { /* Puedes poner un defaultValue más específico si quieres */ });
        const mailConfig = config.mail_config;

        if (!mailConfig || !mailConfig.host || !mailConfig.user || !mailConfig.pass || mailConfig.port === undefined || mailConfig.secure === undefined) {
            console.error('⚠️ Configuración de correo incompleta o inválida en configuracion.json. No se pudo inicializar el transportador de correo.');
            return;
        }

        transporter = nodemailer.createTransport({
            host: mailConfig.host,
            port: parseInt(mailConfig.port, 10), // Asegurarse de que el puerto sea un número
            secure: mailConfig.secure,
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass
            },
        });

        transporter.verify(function(error, success) {
            if (error) {
                console.error('⚠️ Error al configurar el transportador de correo. Revisa la sección "mail_config" en configuracion.json:', error.message);
            } else {
                console.log('✅ Servidor de correo listo para enviar mensajes.');
            }
        });
    } catch (error) {
        console.error('❌ Error al inicializar el transportador de correo desde configuracion.json:', error);
    }
}


// --- Función para Enviar Correo de Corte de Ventas Automático ---
async function enviarCorteAutomatico() {
    // Asegurarse de que el transporter esté inicializado antes de intentar enviar
    if (!transporter) {
        console.error('❌ Transportador de correo no inicializado. No se puede enviar el corte automático.');
        return;
    }
    try {
        const config = await leerArchivo(CONFIG_PATH); // Volver a leer la configuración para obtener la última versión
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        const cortesData = await leerArchivo(CORTES_PATH, { cortes: [] });

        const hoy = new Date();
        const offset = -4; // UTC-4 para Venezuela (Maracaibo, Zulia)
        const localHoy = new Date(hoy.getTime() + (hoy.getTimezoneOffset() * 60000) + (offset * 3600000));
        const fechaCorte = localHoy.toISOString().split('T')[0];

        const ticketsYaIncluidos = new Set();
        cortesData.cortes.forEach(corte => {
            corte.ventasIncluidas.forEach(ticketId => ticketsYaIncluidos.add(ticketId));
        });

        const ventasParaCorte = ventasData.ventas.filter(venta =>
            venta.estado === 'confirmado' &&
            venta.fechaConfirmacion &&
            new Date(venta.fechaConfirmacion).toISOString().split('T')[0] === fechaCorte &&
            !ticketsYaIncluidos.has(venta.numeroTicket)
        );

        if (ventasParaCorte.length === 0) {
            console.log(`ℹ️ No hay ventas confirmadas pendientes de corte para hoy ${fechaCorte}.`);
            return;
        }

        const totalVentasBs = ventasParaCorte.reduce((sum, venta) => sum + venta.valorTotalBs, 0);
        const totalVentasUsd = ventasParaCorte.reduce((sum, venta) => sum + venta.valorTotalUsd, 0);

        const numerosTicketsCorte = ventasParaCorte.map(venta => venta.numeroTicket);

        const nuevoCorte = {
            id: `corte-${Date.now()}`,
            fechaCorte: fechaCorte,
            totalVentasBs: parseFloat(totalVentasBs.toFixed(2)),
            totalVentasUsd: parseFloat(totalVentasUsd.toFixed(2)),
            cantidadVentas: ventasParaCorte.length,
            ventasIncluidas: numerosTicketsCorte,
            detalleVentas: ventasParaCorte
        };

        cortesData.cortes.push(nuevoCorte);
        await escribirArchivo(CORTES_PATH, cortesData);
        console.log(`✅ Corte de ventas del ${fechaCorte} generado y guardado. Total Bs: ${nuevoCorte.totalVentasBs}, Total USD: ${nuevoCorte.totalVentasUsd}`);

        const mailOptions = {
            // Usar el nombre del remitente y la dirección de correo de configuracion.json
            from: config.mail_config.senderName ? `${config.mail_config.senderName} <${config.mail_config.user}>` : config.mail_config.user,
            // Usar la dirección de correo de los reportes del JSON
            to: config.admin_email_for_reports, 
            subject: `Corte Automático de Ventas - ${fechaCorte}`,
            html: `
                <h2>Corte Automático de Ventas - ${fechaCorte}</h2>
                <p><strong>Fecha del Corte:</strong> ${nuevoCorte.fechaCorte}</p>
                <p><strong>Total Ventas (Bs):</strong> ${nuevoCorte.totalVentasBs}</p>
                <p><strong>Total Ventas (USD):</strong> ${nuevoCorte.totalVentasUsd}</p>
                <p><strong>Cantidad de Ventas:</strong> ${nuevoCorte.cantidadVentas}</p>
                <h3>Detalle de Ventas Incluidas:</h3>
                <table border="1" style="width:100%; border-collapse: collapse; font-size: 12px;">
                    <thead>
                        <tr style="background-color: #f2f2f2;">
                            <th style="padding: 8px; text-align: left;">Ticket</th>
                            <th style="padding: 8px; text-align: left;">Números</th>
                            <th style="padding: 8px; text-align: left;">Comprador</th>
                            <th style="padding: 8px; text-align: left;">Teléfono</th>
                            <th style="padding: 8px; text-align: left;">Método Pago</th>
                            <th style="padding: 8px; text-align: left;">Referencia</th>
                            <th style="padding: 8px; text-align: right;">Valor USD</th>
                            <th style="padding: 8px; text-align: right;">Valor Bs</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${ventasParaCorte.map(venta => `
                            <tr>
                                <td style="padding: 8px; border: 1px solid #ddd;">${venta.numeroTicket}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${venta.numeros.join(', ')}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${venta.comprador}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${venta.telefono}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${venta.metodoPago}</td>
                                <td style="padding: 8px; border: 1px solid #ddd;">${venta.referenciaPago}</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${venta.valorTotalUsd}</td>
                                <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${venta.valorTotalBs}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                <p>Este es un correo automático, por favor no responder.</p>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('✉️ Correo de corte de ventas enviado exitosamente.');

    } catch (error) {
        console.error('❌ Error al generar o enviar el corte automático de ventas:', error);
    }
}

// --- Tareas Programadas (Cron Jobs) ---
// El cron job llamará a enviarCorteAutomatico, que ahora verifica si el transporter está inicializado
cron.schedule('59 23 * * *', () => {
    console.log('⏳ Ejecutando tarea programada: Envío de corte automático de ventas...');
    enviarCorteAutomatico();
}, {
    scheduled: true,
    timezone: "America/Caracas"
});

// --- Rutas de la API (Panel del Cliente) ---
// Obtener números disponibles (para el panel del cliente)
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        const numerosData = await leerArchivo(NUMEROS_PATH, { numeros: [] });

        if (config.pagina_bloqueada) {
            return res.status(200).json({
                paginaBloqueada: true,
                message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.',
                fechaSorteo: config.fecha_sorteo,
                numeroSorteoCorrelativo: config.numero_sorteo_correlativo
            });
        }

        if (!config.fecha_sorteo) {
            return res.status(200).json({
                numerosDisponibles: [],
                message: 'No hay una fecha de sorteo configurada por el administrador.',
                paginaBloqueada: false,
                fechaSorteo: null,
                numeroSorteoCorrelativo: null
            });
        }

        const todosLosNumeros = new Set();
        for (let i = 0; i < 1000; i++) {
            todosLosNumeros.add(String(i).padStart(3, '0'));
        }

        const numerosVendidosOPendientes = new Set(
            numerosData.numeros
                .filter(n => n.fecha_sorteo === config.fecha_sorteo && (n.estado === 'confirmado' || n.estado === 'pendiente'))
                .map(n => n.numero)
        );

        const numerosDisponibles = Array.from(todosLosNumeros).filter(numero => !numerosVendidosOPendientes.has(numero));

        res.json({
            numerosDisponibles,
            precioTicket: config.precio_ticket,
            tasaDolar: config.tasa_dolar,
            fechaSorteo: config.fecha_sorteo,
            numeroSorteoCorrelativo: config.numero_sorteo_correlativo,
            paginaBloqueada: false
        });
    } catch (error) {
        console.error('❌ Error al obtener números disponibles:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números disponibles.', error: error.message });
    }
});


// Ruta para registrar una venta (POST)
app.post('/api/ventas', async (req, res) => {
    try {
        const {
            numeros,
            comprador,
            cedula,
            telefono,
            email,
            metodoPago,
            referenciaPago,
            valorTotalUsd,
            valorTotalBs,
            tasaAplicada,
            fechaSorteo
        } = req.body;

        const config = await leerArchivo(CONFIG_PATH, { fecha_sorteo: null, precio_ticket: 0, tasa_dolar: 0, pagina_bloqueada: false, numero_sorteo_correlativo: 1 });
        const numerosRegistrados = await leerArchivo(NUMEROS_PATH, { numeros: [] });
        const ventasRegistradas = await leerArchivo(VENTAS_PATH, { ventas: [] });

        // --- VALIDACIONES DEL SERVIDOR ---
        if (config.pagina_bloqueada) {
            return res.status(403).json({ message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.' });
        }

        if (!config.fecha_sorteo) {
            return res.status(400).json({ message: 'No hay una fecha de sorteo configurada por el administrador.' });
        }

        if (fechaSorteo !== config.fecha_sorteo) {
            console.warn(`⚠️ Alerta: Fecha de sorteo del cliente (${fechaSorteo}) no coincide con la del servidor (${config.fecha_sorteo}).`);
            return res.status(400).json({ message: `La fecha del sorteo en la solicitud (${fechaSorteo}) no coincide con la fecha del sorteo actual configurada (${config.fecha_sorteo}). Por favor, recargue la página.` });
        }

        if (!Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({ message: 'Debe seleccionar al menos un número (formato: array de strings).' });
        }

        const numerosInvalidos = numeros.filter(num => typeof num !== 'string' || !/^\d{3}$/.test(num));
        if (numerosInvalidos.length > 0) {
            return res.status(400).json({ message: `Cada número seleccionado debe ser un string de 3 dígitos. Números inválidos: ${numerosInvalidos.join(', ')}` });
        }

        if (!comprador || typeof comprador !== 'string' || comprador.trim() === '') {
            return res.status(400).json({ message: 'El nombre del comprador es obligatorio y debe ser un texto.' });
        }
        if (!telefono || typeof telefono !== 'string' || telefono.trim() === '') {
            return res.status(400).json({ message: 'El teléfono es obligatorio y debe ser un texto.' });
        }
        if (!metodoPago || typeof metodoPago !== 'string' || metodoPago.trim() === '') {
            return res.status(400).json({ message: 'El método de pago es obligatorio y debe ser un texto.' });
        }
        if (!referenciaPago || typeof referenciaPago !== 'string' || referenciaPago.trim() === '') {
            return res.status(400).json({ message: 'La referencia de pago es obligatoria y debe ser un texto.' });
        }

        const parsedValorTotalUsd = parseFloat(valorTotalUsd);
        const parsedValorTotalBs = parseFloat(valorTotalBs);
        const parsedTasaAplicada = parseFloat(tasaAplicada);

        if (isNaN(parsedValorTotalUsd) || parsedValorTotalUsd <= 0 ||
            isNaN(parsedValorTotalBs) || parsedValorTotalBs <= 0 ||
            isNaN(parsedTasaAplicada) || parsedTasaAplicada <= 0) {
            return res.status(400).json({ message: 'Los valores de pago (USD, Bs, Tasa) deben ser numéricos y mayores que cero.' });
        }

        const numerosTomados = numerosRegistrados.numeros.filter(n =>
            numeros.includes(n.numero) &&
            n.fecha_sorteo === config.fecha_sorteo &&
            (n.estado === 'pendiente' || n.estado === 'confirmado')
        ).map(n => n.numero);

        if (numerosTomados.length > 0) {
            return res.status(409).json({
                message: `¡Ups! Los siguientes números ya están vendidos para el sorteo del ${config.fecha_sorteo}: ${numerosTomados.join(', ')}. Por favor, elige otros.`,
                numerosTomados: numerosTomados
            });
        }

        const numeroTicket = `T${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

        let comprobanteUrl = null;
        if (req.files && req.files.comprobante) {
            const comprobante = req.files.comprobante;
            const uploadDir = path.join(__dirname, 'uploads');
            const uploadPath = path.join(uploadDir, `${numeroTicket}-${comprobante.name}`);
            await comprobante.mv(uploadPath);
            comprobanteUrl = `/uploads/${numeroTicket}-${comprobante.name}`;
            console.log(`Comprobante subido: ${comprobanteUrl}`);
        }

        const nuevaVenta = {
            numeroTicket,
            numeros,
            comprador,
            cedula: cedula || null,
            telefono,
            email: email || null,
            metodoPago,
            referenciaPago,
            valorTotalUsd: parsedValorTotalUsd,
            valorTotalBs: parsedValorTotalBs,
            tasaAplicada: parsedTasaAplicada,
            fechaCompra: new Date().toISOString(),
            fechaSorteo: config.fecha_sorteo,
            estado: 'pendiente',
            comprobanteUrl: comprobanteUrl,
            fechaConfirmacion: null,
            confirmadoPor: null
        };
        ventasRegistradas.ventas.push(nuevaVenta);
        await escribirArchivo(VENTAS_PATH, ventasRegistradas);

        const numerosActualizados = numerosRegistrados.numeros.concat(
            numeros.map(num => ({
                numero: num,
                fecha_sorteo: config.fecha_sorteo,
                estado: 'pendiente',
                numeroTicket: numeroTicket
            }))
        );
        numerosRegistrados.numeros = numerosActualizados;
        await escribirArchivo(NUMEROS_PATH, numerosRegistrados);

        res.status(201).json({ message: 'Venta registrada con éxito. Pendiente de confirmación.', venta: nuevaVenta });

    } catch (error) {
        console.error('❌ Error al registrar la venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar la venta.', error: error.message });
    }
});

// --- Rutas de la API (Panel de Administración) ---
// Obtener todas las ventas
app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        res.json(ventasData.ventas);
    } catch (error) {
        console.error('❌ Error al obtener ventas para el panel de administración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.', error: error.message });
    }
});

// Obtener una venta específica por ID de ticket
app.get('/api/admin/ventas/:ticketId', async (req, res) => {
    try {
        const { ticketId } = req.params;
        const ventasData = await leerArchivo(VENTAS_PATH, { ventas: [] });
        const venta = ventasData.ventas.find(v => v.numeroTicket === ticketId);

        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }
        res.json(venta);
    } catch (error) {
        console.error('❌ Error al obtener el detalle de la venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener el detalle de la venta.', error: error.message });
    }
});


// Actualizar el estado de una venta (confirmar, rechazar, etc.)
app.patch('/api/admin/ventas/:ticketId/estado', async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { estado, confirmadoPor } = req.body;

        if (!['pendiente', 'confirmado', 'rechazado'].includes(estado)) {
            return res.status(400).json({ message: 'Estado de venta no válido.' });
        }
        if (estado === 'confirmado' && (!confirmadoPor || typeof confirmadoPor !== 'string' || confirmadoPor.trim() === '')) {
            return res.status(400).json({ message: 'El campo "confirmadoPor" es requerido al confirmar una venta.' });
        }

        const ventasData = await leerArchivo(VENTAS_PATH);
        const numerosData = await leerArchivo(NUMEROS_PATH);

        const ventaIndex = ventasData.ventas.findIndex(v => v.numeroTicket === ticketId);
        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        const venta = ventasData.ventas[ventaIndex];
        if (estado === 'confirmado' && venta.estado !== 'confirmado') {
            venta.fechaConfirmacion = new Date().toISOString();
            venta.confirmadoPor = confirmadoPor;
        } else if (estado !== 'confirmado') {
            venta.fechaConfirmacion = null;
            venta.confirmadoPor = null;
        }
        venta.estado = estado;


        if (estado === 'rechazado' && venta.comprobanteUrl) {
            const filePath = path.join(__dirname, venta.comprobanteUrl);
            try {
                await fs.unlink(filePath);
                console.log(`🗑️ Comprobante ${filePath} eliminado tras rechazo.`);
                venta.comprobanteUrl = null;
            } catch (unlinkError) {
                console.warn(`⚠️ No se pudo eliminar el comprobante ${filePath}:`, unlinkError.message);
            }
        }
        await escribirArchivo(VENTAS_PATH, ventasData);

        for (const numero of venta.numeros) {
            const numeroIndex = numerosData.numeros.findIndex(n =>
                n.numero === numero && n.numeroTicket === ticketId && n.fecha_sorteo === venta.fechaSorteo
            );
            if (numeroIndex !== -1) {
                numerosData.numeros[numeroIndex].estado = estado;
            } else {
                console.warn(`⚠️ Número ${numero} no encontrado en numeros.json para ticket ${ticketId}.`);
            }
        }
        await escribirArchivo(NUMEROS_PATH, numerosData);

        res.json({ message: `Estado de la venta ${ticketId} actualizado a "${estado}".`, venta });

    } catch (error) {
        console.error('❌ Error al actualizar el estado de la venta:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el estado de la venta.', error: error.message });
    }
});


// Ruta para obtener la configuración global
app.get('/api/admin/config', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_PATH);
        res.json(config);
    } catch (error) {
        console.error('❌ Error al obtener la configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener la configuración.', error: error.message });
    }
});

// CORRECCIÓN para el error PUT /api/admin/configuracion 404
// Esta ruta ahora coincide con lo que tu cliente está enviando
app.put('/api/admin/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        if (newConfig.fecha_sorteo) {
            const sorteoDate = new Date(newConfig.fecha_sorteo);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            sorteoDate.setHours(0, 0, 0, 0);

            if (sorteoDate < today) {
                return res.status(400).json({ message: 'La fecha del sorteo no puede ser en el pasado.' });
            }
        }
        if (newConfig.precio_ticket !== undefined && (isNaN(parseFloat(newConfig.precio_ticket)) || parseFloat(newConfig.precio_ticket) <= 0)) {
            return res.status(400).json({ message: 'El precio del ticket debe ser un número positivo.' });
        }
        if (newConfig.tasa_dolar !== undefined && (isNaN(parseFloat(newConfig.tasa_dolar)) || parseFloat(newConfig.tasa_dolar) <= 0)) {
            return res.status(400).json({ message: 'La tasa del dólar debe ser un número positivo.' });
        }
        if (newConfig.numero_sorteo_correlativo !== undefined && (isNaN(parseInt(newConfig.numero_sorteo_correlativo, 10)) || parseInt(newConfig.numero_sorteo_correlativo, 10) <= 0)) {
            return res.status(400).json({ message: 'El número de sorteo correlativo debe ser un entero positivo.' });
        }

        await escribirArchivo(CONFIG_PATH, newConfig);
        res.json({ message: 'Configuración actualizada con éxito.', config: newConfig });
    } catch (error) {
        console.error('❌ Error al actualizar la configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar la configuración.', error: error.message });
    }
});

// Obtener registros de cortes (para el panel de administración)
app.get('/api/admin/cortes', async (req, res) => {
    try {
        const cortesData = await leerArchivo(CORTES_PATH, { cortes: [] });
        res.json(cortesData.cortes);
    } catch (error) {
        console.error('❌ Error al obtener los registros de cortes:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener los cortes.', error: error.message });
    }
});

// CORRECCIÓN para el error GET /api/admin/horarios-zulia 404
// Agregada esta ruta para que tu cliente pueda cargar los horarios
app.get('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const horarios = await leerArchivo(HORARIOS_ZULIA_PATH, { horarios: [] });
        res.json(horarios);
    } catch (error) {
        console.error('❌ Error al obtener horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.', error: error.message });
    }
});

// Para que el panel de administración pueda GUARDAR/ACTUALIZAR los horarios
app.post('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const newHorarios = req.body;
        if (!Array.isArray(newHorarios)) {
            return res.status(400).json({ message: 'Los datos de horarios deben ser un array.' });
        }
        await escribirArchivo(HORARIOS_ZULIA_PATH, { horarios: newHorarios });
        res.json({ message: 'Horarios del Zulia actualizados con éxito.', horarios: newHorarios });
    } catch (error) {
        console.error('❌ Error al actualizar horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar horarios.', error: error.message });
    }
});


// Ruta para obtener horarios del Zulia para el cliente (sin info de admin)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horariosData = await leerArchivo(HORARIOS_ZULIA_PATH, { horarios: [] });
        res.json(horariosData.horarios);
    } catch (error) {
        console.error('❌ Error al obtener horarios del Zulia para el cliente:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.', error: error.message });
    }
});


// --- Inicio del Servidor ---
// Convertimos la función de escucha a async para poder esperar a la carga de archivos y la inicialización del transporter
app.listen(port, async () => { 
    console.log(`✨ Servidor escuchando en http://localhost:${port}`);
    console.log('--- Rutas de la API ---');
    console.log(`➡️ Cliente:`);
    console.log(`   - GET /api/numeros-disponibles`);
    console.log(`   - POST /api/ventas`);
    console.log(`   - GET /api/horarios-zulia`);
    console.log(`➡️ Administración:`);
    console.log(`   - GET /api/admin/ventas`);
    console.log(`   - GET /api/admin/ventas/:ticketId`);
    console.log(`   - PATCH /api/admin/ventas/:ticketId/estado`);
    console.log(`   - GET /api/admin/config`);
    console.log(`   - PUT /api/admin/configuracion (para actualizar config)`);
    console.log(`   - GET /api/admin/cortes`);
    console.log(`   - GET /api/admin/horarios-zulia`);
    console.log(`   - POST /api/admin/horarios-zulia (para actualizar)`);

    // Asegurarse de que los archivos JSON existan al inicio
    // Esperamos a que configuracion.json se cargue para poder inicializar el transporter
    await leerArchivo(CONFIG_PATH); //
    await leerArchivo(NUMEROS_PATH); //
    await leerArchivo(VENTAS_PATH); //
    await leerArchivo(CORTES_PATH); //
    await leerArchivo(HORARIOS_ZULIA_PATH); //

    // Inicializar el transporter después de que todos los archivos de configuración iniciales estén listos
    await initializeTransporter(); //
});