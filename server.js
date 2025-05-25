// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer'); // Mantenemos nodemailer
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
app.use(fileUpload());

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'configuracion.json');
const NUMEROS_FILE = path.join(DATA_DIR, 'numeros.json');
const VENTAS_FILE = path.join(DATA_DIR, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(DATA_DIR, 'horariosZulia.json');

const COMPROBANTES_DIR = path.join(__dirname, 'comprobantes');

// Configuración de Nodemailer (usando variables de entorno)
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true', // true para 465, false para otros puertos como 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Función para enviar correo de ventas
async function sendSalesEmail(toEmail, salesData, drawDate, drawNumber) {
    if (!toEmail) {
        console.warn("No se ha configurado un correo electrónico para enviar el reporte.");
        return;
    }

    let emailContent = `
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 800px; margin: 20px auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; background-color: #f9f9f9; }
                h2 { color: #0056b3; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                th { background-color: #f2f2f2; }
                .footer { margin-top: 30px; font-size: 0.9em; color: #777; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Reporte de Ventas - Sorteo ${drawNumber} (${drawDate})</h2>
                <p>Adjunto encontrarás un resumen de las ventas realizadas hasta el corte.</p>
    `;

    if (salesData && salesData.length > 0) {
        emailContent += `
            <h3>Detalle de Ventas:</h3>
            <table>
                <thead>
                    <tr>
                        <th>Ticket</th>
                        <th>Números</th>
                        <th>Comprador</th>
                        <th>Teléfono</th>
                        <th>Valor USD</th>
                        <th>Valor Bs</th>
                        <th>Método Pago</th>
                    </tr>
                </thead>
                <tbody>
        `;
        salesData.forEach(sale => {
            emailContent += `
                <tr>
                    <td>${sale.numero_ticket}</td>
                    <td>${sale.numeros_comprados.join(', ')}</td>
                    <td>${sale.nombre_apellido}</td>
                    <td>${sale.codigo_pais}${sale.telefono}</td>
                    <td>${sale.valor_total_usd.toFixed(2)}</td>
                    <td>${sale.valor_total_bs.toFixed(2)}</td>
                    <td>${sale.metodo_pago}</td>
                </tr>
            `;
        });
        emailContent += `
                </tbody>
            </table>
        `;
    } else {
        emailContent += `
            <p>No se registraron ventas para el sorteo ${drawNumber} (${drawDate}).</p>
        `;
    }

    emailContent += `
                <div class="footer">
                    <p>Este es un correo automático, por favor no responda.</p>
                    <p>Sistema de Rifas y Loterías</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const mailOptions = {
        from: process.env.EMAIL_FROM, // Debe ser el email configurado en EMAIL_USER
        to: toEmail,
        subject: `Reporte Diario de Ventas - Sorteo ${drawNumber} (${drawDate})`,
        html: emailContent,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Correo de reporte enviado a ${toEmail} para el sorteo ${drawNumber}.`);
    } catch (error) {
        console.error('Error al enviar el correo de reporte:', error);
        // Si el correo no se envía, la tarea cron debe continuar para reiniciar los números.
    }
}


// Función auxiliar para asegurar que el directorio de datos exista
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        console.log(`Directorio de datos (${DATA_DIR}) verificado/creado.`);
    } catch (error) {
        console.error('Error al crear directorio de datos:', error);
    }
}

// Función auxiliar para asegurar que el directorio de comprobantes exista
async function ensureComprobantesDir() {
    try {
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
        console.log(`Directorio de comprobantes (${COMPROBANTES_DIR}) verificado/creado.`);
    } catch (error) {
        console.error('Error al crear directorio de comprobantes:', error);
    }
}

// Función auxiliar para leer archivos JSON
async function readJsonFile(filePath, defaultValue = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await writeJsonFile(filePath, defaultValue);
            return defaultValue;
        }
        throw error;
    }
}

// Función auxiliar para escribir archivos JSON
async function writeJsonFile(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Rutas de la API ---

// Ruta para obtener y actualizar la configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE, {
            precio_ticket: 1.00,
            tasa_dolar: 38.00,
            fecha_sorteo: moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD'), // Mañana
            numero_sorteo_correlativo: 1,
            bloquear_pagina: false,
            // admin_email ya no se guarda en el config.json
        });
        res.json(config);
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener la configuración.' });
    }
});

app.put('/api/configuracion', async (req, res) => {
    try {
        let config = await readJsonFile(CONFIG_FILE, {});
        const { precio_ticket, tasa_dolar, fecha_sorteo, numero_sorteo_correlativo, bloquear_pagina } = req.body;

        if (precio_ticket !== undefined) config.precio_ticket = parseFloat(precio_ticket);
        if (tasa_dolar !== undefined) config.tasa_dolar = parseFloat(tasa_dolar);
        if (fecha_sorteo !== undefined) config.fecha_sorteo = fecha_sorteo;
        if (numero_sorteo_correlativo !== undefined) config.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo);
        if (bloquear_pagina !== undefined) config.bloquear_pagina = Boolean(bloquear_pagina);

        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Configuración actualizada con éxito.', config });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar la configuración.' });
    }
});

// Ruta para obtener y actualizar los números disponibles
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE, Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        })));
        res.json(numeros);
    } catch (error) {
        console.error('Error al obtener números:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.' });
    }
});

app.post('/api/numeros/comprar', async (req, res) => {
    const { numerosSeleccionados, nombre_apellido, telefono, codigo_pais, cedula, metodo_pago, referencia_pago, valor_total_usd, valor_total_bs } = req.body;
    let comprobanteFile = req.files ? req.files.comprobante : null;

    if (!numerosSeleccionados || !Array.isArray(numerosSeleccionados) || numerosSeleccionados.length === 0) {
        return res.status(400).json({ message: 'Debe seleccionar al menos un número.' });
    }

    if (!nombre_apellido || !telefono || !codigo_pais || !cedula || !metodo_pago || valor_total_usd === undefined || valor_total_bs === undefined) {
        return res.status(400).json({ message: 'Faltan datos obligatorios del comprador o del pago.' });
    }

    try {
        let numeros = await readJsonFile(NUMEROS_FILE);
        let ventas = await readJsonFile(VENTAS_FILE, []);
        let config = await readJsonFile(CONFIG_FILE);

        const fechaSorteo = config.fecha_sorteo;
        const numeroSorteoCorrelativo = config.numero_sorteo_correlativo;

        // Verificar si los números seleccionados ya fueron comprados
        const numerosYaComprados = numerosSeleccionados.filter(nro => {
            const numeroObj = numeros.find(num => num.numero === nro);
            return numeroObj && numeroObj.comprado;
        });

        if (numerosYaComprados.length > 0) {
            return res.status(409).json({
                message: `Los siguientes números ya han sido comprados: ${numerosYaComprados.join(', ')}. Por favor, intente con otros.`,
                numeros_comprados: numerosYaComprados
            });
        }

        // Marcar números como comprados
        numerosSeleccionados.forEach(nro => {
            const index = numeros.findIndex(num => num.numero === nro);
            if (index !== -1) {
                numeros[index].comprado = true;
            }
        });

        await writeJsonFile(NUMEROS_FILE, numeros);

        const numeroTicket = Math.random().toString(36).substr(2, 9).toUpperCase(); // Generar un ID de ticket simple
        let comprobanteUrl = null;

        if (comprobanteFile) {
            const fileExtension = path.extname(comprobanteFile.name);
            const fileName = `comprobante_${Date.now()}${fileExtension}`;
            const filePath = path.join(COMPROBANTES_DIR, fileName);
            await comprobanteFile.mv(filePath);
            comprobanteUrl = `comprobantes/${fileName}`; // Ruta relativa para el frontend
        }

        const nuevaVenta = {
            id: Date.now(), // ID único para la venta
            fecha_hora_compra: moment().tz("America/Caracas").toISOString(),
            fecha_sorteo: fechaSorteo,
            numero_sorteo_correlativo: numeroSorteoCorrelativo,
            numero_ticket: numeroTicket,
            nombre_apellido,
            telefono,
            codigo_pais,
            cedula,
            metodo_pago,
            referencia_pago: referencia_pago || 'N/A',
            numeros_comprados: numerosSeleccionados,
            valor_total_usd,
            valor_total_bs,
            comprobante_url: comprobanteUrl,
            status: 'pendiente' // Puedes añadir un status inicial
        };
        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);

        res.status(200).json({ message: 'Números comprados con éxito.', venta: nuevaVenta });
    } catch (error) {
        console.error('Error al procesar la compra:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});

// Rutas para Horarios del Zulia
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE, []);
        res.json(horarios);
    } catch (error) {
        console.error('Error al obtener horarios del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios del Zulia.' });
    }
});

app.post('/api/horarios-zulia', async (req, res) => {
    const { hora } = req.body;
    if (!hora) {
        return res.status(400).json({ message: 'La hora es obligatoria.' });
    }
    try {
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE, []);
        const newHorario = { id: Date.now(), hora };
        horarios.push(newHorario);
        await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
        res.status(201).json({ message: 'Horario agregado con éxito.', horario: newHorario });
    } catch (error) {
        console.error('Error al agregar horario del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al agregar horario del Zulia.' });
    }
});

app.delete('/api/horarios-zulia/:id', async (req, res) => {
    const { id } = req.params;
    try {
        let horarios = await readJsonFile(HORARIOS_ZULIA_FILE, []);
        const initialLength = horarios.length;
        horarios = horarios.filter(h => h.id !== parseInt(id));
        if (horarios.length === initialLength) {
            return res.status(404).json({ message: 'Horario no encontrado.' });
        }
        await writeJsonFile(HORARIOS_ZULIA_FILE, horarios);
        res.json({ message: 'Horario eliminado con éxito.' });
    } catch (error) {
        console.error('Error al eliminar horario del Zulia:', error);
        res.status(500).json({ message: 'Error interno del servidor al eliminar horario del Zulia.' });
    }
});


// Rutas para Gestión de Ventas
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.' });
    }
});

app.post('/api/corte-ventas', async (req, res) => {
    try {
        const now = moment().tz("America/Caracas");
        let ventas = await readJsonFile(VENTAS_FILE, []);
        let config = await readJsonFile(CONFIG_FILE);

        const salesForReport = ventas.filter(venta =>
            moment(venta.fecha_hora_compra).tz("America/Caracas").isSame(now, 'day')
        );

        // Envío de correo en el corte manual
        const adminEmailFromEnv = process.env.ADMIN_REPORT_EMAIL; // Obtener el email del .env
        if (adminEmailFromEnv) {
            await sendSalesEmail(adminEmailFromEnv, salesForReport, config.fecha_sorteo, config.numero_sorteo_correlativo);
            console.log(`Correo de corte de ventas enviado a ${adminEmailFromEnv}`);
        } else {
            console.warn('No se ha configurado un correo de administrador para reportes en las variables de entorno.');
        }

        // Reiniciar números disponibles
        const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
        console.log('Números disponibles reiniciados.');

        // Actualizar la fecha del próximo sorteo a mañana y el correlativo
        const nextDrawDate = now.clone().add(1, 'days').format('YYYY-MM-DD');
        config.fecha_sorteo = nextDrawDate;
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
        await writeJsonFile(CONFIG_FILE, config);
        console.log(`Fecha del próximo sorteo actualizada a: ${nextDrawDate}`);

        res.json({ message: 'Corte de ventas realizado con éxito. Números reiniciados y fecha de sorteo actualizada.' });
    } catch (error) {
        console.error('Error al realizar el corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar el corte de ventas.', error: error.message });
    }
});

// Ruta para exportar todas las ventas a un archivo Excel
app.get('/api/ventas/exportar-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE, []);
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        // Columnas
        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 15 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 20 },
            { header: 'Comprador', key: 'nombre_apellido', width: 30 },
            { header: 'Teléfono', key: 'telefono_completo', width: 20 },
            { header: 'Cédula', key: 'cedula', width: 15 },
            { header: 'Números Comprados', key: 'numeros_comprados', width: 30 },
            { header: 'Valor USD', key: 'valor_total_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_total_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'Comprobante URL', key: 'comprobante_url', width: 40 }
        ];

        // Añadir filas
        ventas.forEach(venta => {
            worksheet.addRow({
                fecha_hora_compra: moment.tz(venta.fecha_hora_compra, "America/Caracas").format('DD/MM/YYYY HH:mm:ss'),
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo_correlativo: venta.numero_sorteo_correlativo,
                numero_ticket: venta.numero_ticket,
                nombre_apellido: venta.nombre_apellido,
                telefono_completo: `${venta.codigo_pais}${venta.telefono}`,
                cedula: venta.cedula,
                numeros_comprados: venta.numeros_comprados.join(', '),
                valor_total_usd: venta.valor_total_usd,
                valor_total_bs: venta.valor_total_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                comprobante_url: venta.comprobante_url ? `${API_BASE_URL}/${venta.comprobante_url}` : 'N/A'
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + 'ventas.xlsx');

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas a Excel.' });
    }
});

// Servir archivos estáticos (comprobantes, si es necesario)
app.use('/comprobantes', express.static(COMPROBANTES_DIR));

// Tarea programada diaria para corte de ventas, reinicio de números y actualización de fecha
// Se ejecutará todos los días a las 00:00 (medianoche) en la zona horaria de Caracas.
cron.schedule('0 0 * * *', async () => {
    const now = moment().tz("America/Caracas");
    console.log(`Tarea cron de corte de ventas iniciada a las ${now.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        let config = await readJsonFile(CONFIG_FILE);
        const currentDrawDate = moment(config.fecha_sorteo).tz("America/Caracas").format('YYYY-MM-DD');
        const todayFormatted = now.format('YYYY-MM-DD'); // La fecha actual para la cual se generará el reporte

        // Solo reiniciar números y actualizar fecha si la fecha del sorteo en config es el día actual o anterior
        // Esto previene reinicios múltiples si el servidor se reinicia varias veces en un mismo día
        // y asegura que el sorteo se procese para el día correcto.
        // La condición aquí es que el `fecha_sorteo` del config sea *igual o anterior* a `hoy` para procesar el corte.
        if (moment(currentDrawDate).isSameOrBefore(todayFormatted, 'day')) {
            console.log('Iniciando reinicio de números y actualización de fecha de sorteo...');

            const adminEmailFromEnv = process.env.ADMIN_REPORT_EMAIL; // Obtener el email del .env
            if (adminEmailFromEnv) {
                let ventas = await readJsonFile(VENTAS_FILE, []);
                const salesForReport = ventas.filter(venta =>
                    // Filtrar ventas que correspondan a la fecha del sorteo que se está "cortando"
                    moment(venta.fecha_sorteo).isSame(currentDrawDate, 'day')
                );
                await sendSalesEmail(adminEmailFromEnv, salesForReport, currentDrawDate, config.numero_sorteo_correlativo);
                console.log(`Correo de corte de ventas automático enviado a ${adminEmailFromEnv} para el sorteo ${currentDrawDate}.`);
            } else {
                console.warn('No se ha configurado un correo de administrador para reportes en las variables de entorno.');
            }

            // Reiniciar números disponibles para el próximo sorteo
            const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
                numero: i.toString().padStart(2, '0'),
                comprado: false
            }));
            await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
            console.log('Números disponibles reiniciados automáticamente para el próximo sorteo.');

            // Actualizar la fecha del próximo sorteo a mañana y el correlativo
            config.fecha_sorteo = now.clone().add(1, 'days').format('YYYY-MM-DD'); // La fecha del sorteo es MAÑANA
            config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
            await writeJsonFile(CONFIG_FILE, config);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${config.fecha_sorteo} y correlativo a ${config.numero_sorteo_correlativo}.`);
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
ensureComprobantesDir().then(() => {
    app.listen(port, () => {
        console.log(`Servidor de la API escuchando en ${API_BASE_URL}`);
        console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app/`);
        console.log(`Plataforma de usuario disponible en: https://tuoportunidadeshoy.netlify.app/`);
    });
}).catch(err => {
    console.error('Error al iniciar el servidor:', err);
});