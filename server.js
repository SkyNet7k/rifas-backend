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
const ExcelJS = require('exceljs'); // Asegúrate de tener 'exceljs' instalado: npm install exceljs

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configura la URL base de tu API, preferiblemente desde variables de entorno
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

const DATA_DIR = path.join(__dirname, 'data');
const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');
const CONFIG_FILE = path.join(DATA_DIR, 'configuracion.json');
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(DATA_DIR, 'resultados_zulia.json');
const COMPROBANTES_REGISTRO_FILE = path.join(DATA_DIR, 'comprobantes.json'); // Archivo para registrar los comprobantes

// Opciones de CORS para permitir solicitudes desde tus frontends
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app',
        'https://tuoportunidadeshoy.netlify.app',
        'http://localhost:8080', // Para desarrollo local del frontend de usuario
        'http://127.0.0.1:5500', // Para Live Server de VS Code
        'http://localhost:3000', // Para desarrollo local si tu backend y frontend corren en el mismo puerto por alguna razón
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json()); // Middleware para parsear JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware para parsear URL-encoded bodies
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    abortOnLimit: true,
    responseOnLimit: 'El archivo excede el límite de tamaño permitido.',
}));

// Servir archivos estáticos para comprobantes (si se guardan en el servidor)
app.use('/comprobantes', express.static(COMPROBANTES_DIR));

// Variables globales para almacenar datos en memoria (se inicializan al inicio)
let configuracion = {};
let numeros = [];
let ventas = [];
let horariosZulia = { horarios_zulia: [] };
let resultadosZulia = [];
let comprobantesRegistros = [];

// --- Funciones de Utilidad para manejo de JSON ---
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Creando archivo vacío.`);
            await writeJsonFile(filePath, {}); // Crea un archivo vacío si no existe
            return {};
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Funciones de Carga Inicial ---
async function ensureDataAndComprobantesDirs() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
}

async function loadInitialData() {
    try {
        configuracion = await readJsonFile(CONFIG_FILE);
        if (Object.keys(configuracion).length === 0) {
            console.log('Configuración inicial vacía, cargando valores predeterminados.');
            configuracion = {
                tasa_dolar: 36.5,
                pagina_bloqueada: false,
                fecha_sorteo: moment().tz("America/Caracas").format('YYYY-MM-DD'),
                precio_ticket: 1.00,
                numero_sorteo_correlativo: 1,
                ultimo_numero_ticket: 0,
                ultima_fecha_resultados_zulia: null,
                admin_whatsapp_numbers: ["584124723776", "584126083355", "584143630488"],
                mail_config: {
                    host: "smtp.gmail.com",
                    port: 465,
                    secure: true,
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS,
                    senderName: "Sistema de Rifas"
                },
                admin_email_for_reports: process.env.ADMIN_EMAIL_REPORTS,
                whatsapp_contact_number: "584124723776", // Número de WhatsApp para el usuario en el frontend
                codigos_pais: [
                    { nombre: "Venezuela", codigo: "+58", predeterminado: true },
                    { nombre: "Colombia", codigo: "+57" },
                    { nombre: "España", codigo: "+34" }
                ],
                metodos_de_pago: ["Pago Móvil", "Transferencia", "Binance", "Zelle"]
            };
            await writeJsonFile(CONFIG_FILE, configuracion);
        }

        numeros = await readJsonFile(NUMEROS_FILE);
        if (!Array.isArray(numeros) || numeros.length === 0) {
            console.log('Números iniciales vacíos o inválidos, inicializando 100 números.');
            numeros = Array.from({ length: 100 }, (_, i) => ({
                numero: String(i).padStart(2, '0'),
                comprado: false
            }));
            await writeJsonFile(NUMEROS_FILE, numeros);
        }

        ventas = await readJsonFile(VENTAS_FILE);
        if (!Array.isArray(ventas)) {
            ventas = [];
            await writeJsonFile(VENTAS_FILE, ventas);
        }

        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE);
        if (!horariosZulia.horarios_zulia) {
            horariosZulia = { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] };
            await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        }

        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE);
        if (!Array.isArray(resultadosZulia)) {
            resultadosZulia = [];
            await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);
        }
        
        comprobantesRegistros = await readJsonFile(COMPROBANTES_REGISTRO_FILE);
        if (!Array.isArray(comprobantesRegistros)) {
            comprobantesRegistros = [];
            await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);
        }


        console.log('Datos iniciales cargados con éxito.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
        process.exit(1); // Salir si los datos esenciales no se pueden cargar
    }
}

// --- Middleware para protección de rutas de administración (Ejemplo) ---
function isAuthenticated(req, res, next) {
    // Implementa tu lógica de autenticación aquí.
    // Por simplicidad, se permite todo por ahora, pero en producción,
    // deberías validar tokens JWT, sesiones, etc.
    // if (req.headers.authorization === 'Bearer YOUR_SECRET_TOKEN') {
    //     next();
    // } else {
    //     res.status(401).json({ message: 'No autorizado' });
    // }
    next(); // Temporalmente permite todas las solicitudes
}

// --- Funciones de Notificación ---
const transporter = nodemailer.createTransport({
    host: configuracion.mail_config.host,
    port: configuracion.mail_config.port,
    secure: configuracion.mail_config.secure,
    auth: {
        user: configuracion.mail_config.user,
        pass: configuracion.mail_config.pass,
    },
});

async function enviarCorreoNotificacion(subject, textContent, htmlContent, attachments = []) {
    if (!configuracion.mail_config.user || !configuracion.mail_config.pass || !configuracion.admin_email_for_reports) {
        console.error('Configuración de correo incompleta. No se puede enviar el correo.');
        return;
    }

    try {
        const mailOptions = {
            from: `"${configuracion.mail_config.senderName}" <${configuracion.mail_config.user}>`,
            to: configuracion.admin_email_for_reports,
            subject: subject,
            text: textContent,
            html: htmlContent,
            attachments: attachments,
        };
        await transporter.sendMail(mailOptions);
        console.log('Correo de notificación enviado con éxito.');
    } catch (error) {
        console.error('Error al enviar correo de notificación:', error);
    }
}

// --- ENDPOINTS DE LA API ---

// 1. Obtener Configuración General
app.get('/configuracion', async (req, res) => {
    try {
        // Asegúrate de enviar solo la información relevante al frontend público
        const publicConfig = {
            tasaDolar: configuracion.tasa_dolar,
            bloquearPagina: configuracion.pagina_bloqueada,
            fechaSorteo: configuracion.fecha_sorteo,
            precioTicket: configuracion.precio_ticket,
            numeroSorteoCorrelativo: configuracion.numero_sorteo_correlativo,
            whatsappContactNumber: configuracion.whatsapp_contact_number, // Nuevo campo
            codigosPais: configuracion.codigos_pais,
            metodosDePago: configuracion.metodos_de_pago
        };
        res.json(publicConfig);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// 2. Obtener Números Disponibles
app.get('/numeros-disponibles', async (req, res) => {
    try {
        const numerosDisponibles = numeros.filter(n => !n.comprado).map(n => n.numero);
        res.json(numerosDisponibles);
    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.' });
    }
});

// 3. Endpoint de Compra
app.post('/comprar', async (req, res) => {
    const { numeros, comprador, telefono, metodo_pago, referencia_pago, valor_usd, valor_bs, fecha_sorteo, numero_sorteo_correlativo } = req.body;

    if (!numeros || !Array.isArray(numeros) || numeros.length === 0 || !comprador || !telefono || !metodo_pago || !referencia_pago || valor_usd === undefined || valor_bs === undefined) {
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra.' });
    }

    try {
        // Verificar si los números aún están disponibles
        const numerosNoDisponibles = numeros.filter(num => {
            const numeroEncontrado = numeros.find(n => n.numero === num);
            return !numeroEncontrado || numeroEncontrado.comprado;
        });

        if (numerosNoDisponibles.length > 0) {
            return res.status(409).json({ message: `Algunos números ya no están disponibles: ${numerosNoDisponibles.join(', ')}` });
        }

        // Actualizar el estado de los números a "comprado"
        numeros.forEach(num => {
            const index = numeros.findIndex(n => n.numero === num);
            if (index !== -1) {
                numeros[index].comprado = true;
            }
        });
        await writeJsonFile(NUMEROS_FILE, numeros);

        // Generar el siguiente número de ticket correlativo
        configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
        await writeJsonFile(CONFIG_FILE, configuracion);
        const numeroTicket = configuracion.ultimo_numero_ticket;

        // Registrar la venta
        const nuevaVenta = {
            id: ventas.length > 0 ? Math.max(...ventas.map(v => v.id)) + 1 : 1,
            fecha_hora_compra: moment().tz("America/Caracas").format('DD/MM/YYYY HH:mm:ss'),
            fecha_sorteo: fecha_sorteo,
            numero_sorteo_correlativo: numero_sorteo_correlativo,
            numero_ticket: numeroTicket,
            numeros: numeros,
            comprador: comprador,
            telefono: telefono,
            valor_usd: valor_usd,
            valor_bs: valor_bs,
            metodo_pago: metodo_pago,
            referencia_pago: referencia_pago,
            url_comprobante: null, // Asumimos que el comprobante se manejará aparte si es necesario
            status: 'pendiente_verificacion' // Añadir un estado inicial
        };
        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);

        // Notificar al administrador (opcional, se puede activar/desactivar)
        const emailSubject = `Nueva Compra - Ticket #${numeroTicket}`;
        const emailHtml = `
            <h3>¡Nueva Apuesta Realizada!</h3>
            <p><strong>Ticket #:</strong> ${numeroTicket}</p>
            <p><strong>Comprador:</strong> ${comprador}</p>
            <p><strong>Teléfono:</strong> ${telefono}</p>
            <p><strong>Números Comprados:</strong> ${numeros.join(', ')}</p>
            <p><strong>Total USD:</strong> $${valor_usd.toFixed(2)}</p>
            <p><strong>Total Bs:</strong> Bs ${valor_bs.toFixed(2)}</p>
            <p><strong>Método de Pago:</strong> ${metodo_pago}</p>
            <p><strong>Referencia de Pago:</strong> ${referencia_pago}</p>
            <p><strong>Fecha/Hora Compra:</strong> ${nuevaVenta.fecha_hora_compra}</p>
            <p><strong>Fecha de Sorteo:</strong> ${fecha_sorteo}</p>
            <p><strong>Nro. Sorteo Correlativo:</strong> ${numero_sorteo_correlativo}</p>
            <p>Por favor, verifica el pago y marca el ticket como verificado en el panel de administración.</p>
        `;
        await enviarCorreoNotificacion(emailSubject, emailHtml, emailHtml);


        res.status(201).json({ message: 'Compra realizada con éxito y números reservados.', ticket: nuevaVenta });

    } catch (error) {
        console.error('Error al procesar la compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});


// 4. NUEVO ENDPOINT: Finalizar Apuesta
// Este endpoint registra que el usuario ha 'finalizado' su interacción con el comprobante,
// y se puede usar para notificar al administrador.
app.post('/finalizar-apuesta', async (req, res) => {
    const datosFinalizacion = req.body;

    if (!datosFinalizacion || Object.keys(datosFinalizacion).length === 0) {
        return res.status(400).json({ message: 'No se recibieron datos para finalizar la apuesta.' });
    }

    try {
        console.log("Datos de finalización de apuesta recibidos:", datosFinalizacion);

        // Aquí podrías:
        // 1. Guardar estos datos en un archivo de log/registro de finalizaciones.
        //    Por ejemplo, en un nuevo archivo `finalizaciones.json` o añadir un campo `finalizado: true`
        //    a la venta existente en `ventas.json` si puedes correlacionarla por `numero_ticket` o similar.
        //    Por simplicidad, vamos a loguearlo y enviarlo por correo.

        // Opcional: Si quieres actualizar una venta existente a un estado "finalizado por el cliente"
        // Necesitarías un identificador único como `numero_ticket` enviado desde el frontend.
        // const { numero_ticket } = datosFinalizacion;
        // if (numero_ticket) {
        //     const index = ventas.findIndex(v => v.numero_ticket === numero_ticket);
        //     if (index !== -1) {
        //         ventas[index].status = 'finalizado_por_cliente'; // Nuevo estado
        //         await writeJsonFile(VENTAS_FILE, ventas);
        //         console.log(`Venta con ticket ${numero_ticket} actualizada a 'finalizado_por_cliente'.`);
        //     }
        // }


        // Notificar al administrador que una apuesta ha sido "finalizada" por el cliente.
        // Esto es útil si el administrador necesita revisar el comprobante o realizar alguna acción manual.
        const emailSubject = `Apuesta Finalizada por Cliente - ${datosFinalizacion.comprador || 'Desconocido'}`;
        const emailHtml = `
            <h3>El Cliente ha Finalizado una Apuesta</h3>
            <p>El cliente ha hecho clic en "Finalizar Apuesta" en el comprobante.</p>
            <p><strong>Comprador:</strong> ${datosFinalizacion.comprador || 'N/A'}</p>
            <p><strong>Teléfono:</strong> ${datosFinalizacion.telefono || 'N/A'}</p>
            <p><strong>Números:</strong> ${datosFinalizacion.numeros ? datosFinalizacion.numeros.join(', ') : 'N/A'}</p>
            <p><strong>Total USD:</strong> $${datosFinalizacion.total_usd ? datosFinalizacion.total_usd.toFixed(2) : 'N/A'}</p>
            <p><strong>Total Bs:</strong> Bs ${datosFinalizacion.total_bs ? datosFinalizacion.total_bs.toFixed(2) : 'N/A'}</p>
            <p><strong>Método de Pago:</strong> ${datosFinalizacion.metodo_pago || 'N/A'}</p>
            <p><strong>Referencia:</strong> ${datosFinalizacion.referencia_pago || 'N/A'}</p>
            <p><strong>Fecha/Hora Finalización:</strong> ${datosFinalizacion.fecha_hora_compra || 'N/A'}</p>
            <p><strong>Fecha Sorteo:</strong> ${datosFinalizacion.fecha_sorteo || 'N/A'}</p>
            <p><strong>Nro. Sorteo:</strong> ${datosFinalizacion.nro_sorteo || 'N/A'}</p>
            <p>Por favor, revisa esta transacción en el panel de administración.</p>
        `;
        await enviarCorreoNotificacion(emailSubject, emailHtml, emailHtml);

        res.status(200).json({ message: 'Datos de finalización de apuesta recibidos con éxito.' });

    } catch (error) {
        console.error('Error al procesar la finalización de apuesta:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la finalización de apuesta.', error: error.message });
    }
});


// 5. Obtener Todas las Ventas (Admin)
app.get('/admin/ventas', isAuthenticated, async (req, res) => {
    try {
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.' });
    }
});

// 6. Cargar Comprobante (Admin)
app.post('/admin/upload-comprobante/:ventaId', isAuthenticated, async (req, res) => {
    const ventaId = parseInt(req.params.ventaId);
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se subió ningún archivo.' });
    }

    const comprobanteFile = req.files.comprobante;
    const uploadPath = path.join(COMPROBANTES_DIR, comprobanteFile.name);

    try {
        await comprobanteFile.mv(uploadPath);

        const ventaIndex = ventas.findIndex(v => v.id === ventaId);
        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        const urlComprobante = `/comprobantes/${comprobanteFile.name}`;
        ventas[ventaIndex].url_comprobante = urlComprobante;
        ventas[ventaIndex].status = 'verificado'; // Cambiar estado a verificado
        await writeJsonFile(VENTAS_FILE, ventas);

        // Registrar en comprobantes.json (si se desea una lista separada)
        const nuevoRegistroComprobante = {
            id: comprobantesRegistros.length > 0 ? Math.max(...comprobantesRegistros.map(c => c.id)) + 1 : 1,
            venta_id: ventaId,
            comprador: ventas[ventaIndex].comprador,
            telefono: ventas[ventaIndex].telefono,
            comprobante_nombre: comprobanteFile.name,
            comprobante_tipo: comprobanteFile.mimetype,
            fecha_subida: moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
            url: urlComprobante
        };
        comprobantesRegistros.push(nuevoRegistroComprobante);
        await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);

        res.json({ message: 'Comprobante subido y venta actualizada con éxito.', url: urlComprobante });
    } catch (error) {
        console.error('Error al subir comprobante:', error);
        res.status(500).json({ message: 'Error al subir el comprobante.', error: error.message });
    }
});

// 7. Eliminar Comprobante (Admin)
app.delete('/admin/delete-comprobante/:ventaId', isAuthenticated, async (req, res) => {
    const ventaId = parseInt(req.params.ventaId);

    try {
        const ventaIndex = ventas.findIndex(v => v.id === ventaId);
        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        const oldComprobanteUrl = ventas[ventaIndex].url_comprobante;
        if (oldComprobanteUrl) {
            const fileName = path.basename(oldComprobanteUrl);
            const filePath = path.join(COMPROBANTES_DIR, fileName);
            try {
                await fs.unlink(filePath);
                console.log(`Archivo de comprobante eliminado: ${filePath}`);
            } catch (unlinkError) {
                if (unlinkError.code === 'ENOENT') {
                    console.warn(`Intento de eliminar comprobante que no existe: ${filePath}`);
                } else {
                    console.error(`Error al eliminar archivo de comprobante: ${unlinkError}`);
                }
            }
        }

        ventas[ventaIndex].url_comprobante = null;
        ventas[ventaIndex].status = 'pendiente_verificacion'; // Volver a pendiente
        await writeJsonFile(VENTAS_FILE, ventas);

        // También eliminar del registro de comprobantes si existe
        comprobantesRegistros = comprobantesRegistros.filter(cr => cr.venta_id !== ventaId);
        await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);

        res.json({ message: 'Comprobante eliminado y venta actualizada.' });
    } catch (error) {
        console.error('Error al eliminar comprobante:', error);
        res.status(500).json({ message: 'Error al eliminar el comprobante.', error: error.message });
    }
});


// 8. Actualizar Precio del Ticket (Admin)
app.post('/admin/actualizar-precio-ticket', isAuthenticated, async (req, res) => {
    const { precio_ticket } = req.body;
    if (precio_ticket === undefined || isNaN(precio_ticket) || parseFloat(precio_ticket) <= 0) {
        return res.status(400).json({ message: 'Precio del ticket inválido.' });
    }
    try {
        configuracion.precio_ticket = parseFloat(precio_ticket);
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Precio del ticket actualizado con éxito.', precio_ticket: configuracion.precio_ticket });
    } catch (error) {
        console.error('Error al actualizar precio del ticket:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 9. Actualizar Tasa Dólar (Admin)
app.post('/admin/actualizar-tasa-dolar', isAuthenticated, async (req, res) => {
    const { tasa_dolar } = req.body;
    if (tasa_dolar === undefined || isNaN(tasa_dolar) || parseFloat(tasa_dolar) <= 0) {
        return res.status(400).json({ message: 'Tasa dólar inválida.' });
    }
    try {
        configuracion.tasa_dolar = parseFloat(tasa_dolar);
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Tasa dólar actualizada con éxito.', tasa_dolar: configuracion.tasa_dolar });
    } catch (error) {
        console.error('Error al actualizar tasa dólar:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 10. Actualizar Fecha de Sorteo (Admin)
app.post('/admin/actualizar-fecha-sorteo', isAuthenticated, async (req, res) => {
    const { fecha_sorteo } = req.body;
    if (!fecha_sorteo || !moment(fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Formato de fecha de sorteo inválido. Use YYYY-MM-DD.' });
    }
    try {
        configuracion.fecha_sorteo = fecha_sorteo;
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Fecha de sorteo actualizada con éxito.', fecha_sorteo: configuracion.fecha_sorteo });
    } catch (error) {
        console.error('Error al actualizar fecha de sorteo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 11. Actualizar Número de Sorteo Correlativo (Admin)
app.post('/admin/actualizar-numero-sorteo-correlativo', isAuthenticated, async (req, res) => {
    const { numero_sorteo_correlativo } = req.body;
    if (numero_sorteo_correlativo === undefined || isNaN(numero_sorteo_correlativo) || parseInt(numero_sorteo_correlativo) < 0) {
        return res.status(400).json({ message: 'Número de sorteo correlativo inválido.' });
    }
    try {
        configuracion.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo);
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Número de sorteo correlativo actualizado con éxito.', numero_sorteo_correlativo: configuracion.numero_sorteo_correlativo });
    } catch (error) {
        console.error('Error al actualizar número de sorteo correlativo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 12. Actualizar Estado de Bloqueo de Página (Admin)
app.post('/admin/actualizar-bloqueo-pagina', isAuthenticated, async (req, res) => {
    const { bloquear_pagina } = req.body;
    if (typeof bloquear_pagina !== 'boolean') {
        return res.status(400).json({ message: 'El valor de bloqueo de página es inválido.' });
    }
    try {
        configuracion.pagina_bloqueada = bloquear_pagina;
        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Estado de bloqueo de página actualizado con éxito.', bloquear_pagina: configuracion.pagina_bloqueada });
    } catch (error) {
        console.error('Error al actualizar estado de bloqueo de página:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 13. Obtener Horarios de Zulia (Admin)
app.get('/admin/horarios-zulia', isAuthenticated, async (req, res) => {
    try {
        res.json(horariosZulia);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 14. Agregar Horario de Zulia (Admin)
app.post('/admin/agregar-horario-zulia', isAuthenticated, async (req, res) => {
    const { horario } = req.body;
    if (!horario) {
        return res.status(400).json({ message: 'Horario es requerido.' });
    }
    try {
        if (!horariosZulia.horarios_zulia.includes(horario)) {
            horariosZulia.horarios_zulia.push(horario);
            await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
            res.status(201).json({ message: 'Horario agregado con éxito.', horarios: horariosZulia.horarios_zulia });
        } else {
            res.status(409).json({ message: 'El horario ya existe.' });
        }
    } catch (error) {
        console.error('Error al agregar horario de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 15. Eliminar Horario de Zulia (Admin)
app.delete('/admin/eliminar-horario-zulia/:horario', isAuthenticated, async (req, res) => {
    const { horario } = req.params;
    try {
        const initialLength = horariosZulia.horarios_zulia.length;
        horariosZulia.horarios_zulia = horariosZulia.horarios_zulia.filter(h => h !== horario);
        if (horariosZulia.horarios_zulia.length < initialLength) {
            await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
            res.json({ message: 'Horario eliminado con éxito.', horarios: horariosZulia.horarios_zulia });
        } else {
            res.status(404).json({ message: 'Horario no encontrado.' });
        }
    } catch (error) {
        console.error('Error al eliminar horario de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 16. Obtener Resultados de Zulia (Admin)
app.get('/admin/resultados-zulia', isAuthenticated, async (req, res) => {
    try {
        res.json(resultadosZulia);
    } catch (error) {
        console.error('Error al obtener resultados de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 17. Agregar Resultado de Zulia (Admin)
app.post('/admin/agregar-resultado-zulia', isAuthenticated, async (req, res) => {
    const { fecha, horario, resultado } = req.body;
    if (!fecha || !horario || !resultado) {
        return res.status(400).json({ message: 'Fecha, horario y resultado son requeridos.' });
    }
    try {
        resultadosZulia.push({ fecha, horario, resultado });
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);
        res.status(201).json({ message: 'Resultado agregado con éxito.', resultados: resultadosZulia });
    } catch (error) {
        console.error('Error al agregar resultado de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 18. Eliminar Resultado de Zulia (Admin)
app.delete('/admin/eliminar-resultado-zulia/:fecha/:horario/:resultado', isAuthenticated, async (req, res) => {
    const { fecha, horario, resultado } = req.params;
    try {
        const initialLength = resultadosZulia.length;
        resultadosZulia = resultadosZulia.filter(r => !(r.fecha === fecha && r.horario === horario && r.resultado === resultado));
        if (resultadosZulia.length < initialLength) {
            await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);
            res.json({ message: 'Resultado eliminado con éxito.', resultados: resultadosZulia });
        } else {
            res.status(404).json({ message: 'Resultado no encontrado.' });
        }
    } catch (error) {
        console.error('Error al eliminar resultado de Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// 19. Exportar Ventas a Excel (Admin)
app.get('/admin/exportar-ventas-excel', isAuthenticated, async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 10 },
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números', key: 'numeros', width: 40 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 50 },
            { header: 'Estado', key: 'status', width: 20 } // Nuevo campo de estado
        ];

        ventas.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: venta.fecha_hora_compra,
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo_correlativo: venta.numero_sorteo_correlativo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: (venta.numeros && venta.numeros.length > 0) ? venta.numeros.join(', ') : 'N/A',
                valor_usd: (venta.valor_usd !== undefined) ? venta.valor_usd.toFixed(2) : 'N/A',
                valor_bs: (venta.valor_bs !== undefined) ? venta.valor_bs.toFixed(2) : 'N/A',
                metodo_pago: venta.metodo_pago || 'N/A',
                referencia_pago: venta.referencia_pago || 'N/A',
                url_comprobante: venta.url_comprobante || 'N/A',
                status: venta.status || 'N/A' // Asegúrate de que el estado se exporte
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Reporte_Ventas_${moment().format('YYYYMMDD_HHmmss')}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas a Excel.', error: error.message });
    }
});


// 20. Corte de Ventas (Admin)
// Esta ruta se activa manualmente desde el panel de administración
app.post('/admin/corte-ventas', isAuthenticated, async (req, res) => {
    try {
        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');

        // Reiniciar números a no comprados
        numeros.forEach(n => n.comprado = false);
        await writeJsonFile(NUMEROS_FILE, numeros);

        // Guardar las ventas actuales como históricas si es necesario, o limpiar `ventas.json`
        // Para este ejemplo, simplemente vaciamos `ventas.json`
        ventas = [];
        await writeJsonFile(VENTAS_FILE, ventas);

        // Reiniciar el contador de tickets
        configuracion.ultimo_numero_ticket = 0;

        // Actualizar la fecha del próximo sorteo a mañana y el correlativo
        configuracion.fecha_sorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');
        configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;
        await writeJsonFile(CONFIG_FILE, configuracion);

        // Eliminar resultados Zulia de la fecha actual
        resultadosZulia = resultadosZulia.filter(r => r.fecha !== todayFormatted);
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);

        res.json({ message: 'Corte de ventas realizado con éxito. Números, ventas y contador de tickets reiniciados. Fecha de sorteo actualizada.' });
    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar corte de ventas.', error: error.message });
    }
});

// --- TAREA PROGRAMADA (CRON JOB) ---
// Este cron job se ejecuta diariamente para asegurar que la fecha del sorteo
// y los números se reinicien automáticamente después de la fecha del sorteo configurada.
cron.schedule('0 0 * * *', async () => { // Se ejecuta a las 00:00 (medianoche) todos los días
    console.log('Ejecutando tarea programada de verificación de sorteo y reinicio...');
    try {
        // Recargar la configuración para asegurar que es la más reciente
        await loadInitialData();

        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');
        const currentDrawDate = configuracion.fecha_sorteo;

        // Si la fecha del sorteo configurada es hoy o anterior, significa que el sorteo "pasó"
        // y es hora de reiniciar los números para el siguiente sorteo.
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted, 'day')) {
            console.log(`La fecha de sorteo (${currentDrawDate}) es hoy o anterior. Reiniciando números y actualizando fecha.`);

            // Reiniciar números a no comprados
            numeros.forEach(n => n.comprado = false);
            await writeJsonFile(NUMEROS_FILE, numeros);
            console.log('Todos los números han sido reiniciados a no comprados.');

            // Vaciar ventas (o mover a histórico si tienes esa funcionalidad)
            ventas = [];
            await writeJsonFile(VENTAS_FILE, ventas);
            console.log('Registro de ventas vaciado.');

            // Reiniciar el contador de tickets
            configuracion.ultimo_numero_ticket = 0;
            console.log('Contador de tickets reiniciado.');

            // Eliminar resultados Zulia de la fecha actual
            resultadosZulia = resultadosZulia.filter(r => r.fecha !== todayFormatted);
            await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);
            console.log('Resultados de Zulia de hoy eliminados.');

            // Actualizar la fecha del próximo sorteo a mañana y el correlativo
            configuracion.fecha_sorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');
            configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${configuracion.fecha_sorteo} y correlativo a ${configuracion.numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas" // Asegúrate de que la zona horaria sea correcta para la ejecución del cron
});


// Inicialización del servidor
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
            console.log(`Frontend principal disponible en: https://tuoportunidadeshoy.netlify.app`);
        });
    });
}).catch(err => {
    console.error('Error crítico al iniciar el servidor:', err);
    process.exit(1);
});