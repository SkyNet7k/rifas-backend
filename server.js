// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone'); // Asegúrate de que moment-timezone esté instalado
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

const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const COMPROBANTES_FILE = path.join(__dirname, 'comprobantes.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');

// --- Funciones de Utilidad para Leer/Escribir JSON ---
async function readJsonFile(filePath, defaultContent = []) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Creando con contenido por defecto.`);
            await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
            return defaultContent;
        }
        console.error(`Error leyendo archivo ${filePath}:`, error);
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error escribiendo archivo ${filePath}:`, error);
        throw error;
    }
}

// --- Configuración de Nodemailer (Email) ---
let transporter;
let mailConfig;

async function initializeEmailConfig() {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        mailConfig = config.mail_config;
        if (mailConfig && mailConfig.host && mailConfig.user && mailConfig.pass) {
            transporter = nodemailer.createTransport({
                host: mailConfig.host,
                port: mailConfig.port,
                secure: mailConfig.secure, // true for 465, false for other ports
                auth: {
                    user: mailConfig.user,
                    pass: mailConfig.pass,
                },
            });
            console.log('Configuración de email cargada y transporter inicializado.');
        } else {
            console.warn('Configuración de email incompleta en configuracion.json. El envío de correos no funcionará.');
        }
    } catch (error) {
        console.error('Error al inicializar la configuración de email:', error);
    }
}

async function sendEmail(to, subject, htmlContent) {
    if (!transporter) {
        console.error('Transporter de email no inicializado. No se puede enviar el correo.');
        return;
    }
    const adminEmail = (await readJsonFile(CONFIG_FILE)).admin_email_for_reports || mailConfig.user; // Usar el correo del admin para reportes o el de auth

    try {
        let info = await transporter.sendMail({
            from: `"${mailConfig.senderName || 'Sistema de Rifas'}" <${mailConfig.user}>`,
            to: to,
            subject: subject,
            html: htmlContent,
        });
        console.log("Mensaje enviado: %s", info.messageId);
        return info;
    } catch (error) {
        console.error("Error enviando correo:", error);
        if (error.responseCode === 535) {
            console.error("Error de autenticación: Verifica la contraseña de la aplicación de Gmail o las credenciales.");
        }
    }
}

// --- Rutas de la API ---

// Ruta para obtener la configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE, {});
        // Obtener la hora actual en la zona horaria de Venezuela
        const now = moment().tz('America/Caracas');
        const fechaSorteo = moment.tz(config.fecha_sorteo, 'YYYY-MM-DD', 'America/Caracas');

        let isSorteoActivo = true;
        let mensajeSorteo = '';

        // Si la fecha del sorteo ya pasó, el sorteo ha finalizado
        if (now.isAfter(fechaSorteo, 'day')) {
            isSorteoActivo = false;
            mensajeSorteo = 'El sorteo ha finalizado. Espera el próximo evento.';
        } else if (now.isSame(fechaSorteo, 'day')) {
             // Si es el mismo día del sorteo, consideramos que está activo,
             // pero podrías añadir lógica para horarios específicos si lo necesitas.
             isSorteoActivo = true;
             mensajeSorteo = `El sorteo está activo. Fecha del sorteo: ${fechaSorteo.format('DD-MM-YYYY')}`;
        } else {
            isSorteoActivo = true;
            mensajeSorteo = `El sorteo está activo. Fecha del sorteo: ${fechaSorteo.format('DD-MM-YYYY')}`;
        }


        res.json({
            ...config,
            isSorteoActivo: isSorteoActivo,
            mensajeSorteo: mensajeSorteo
        });
    } catch (error) {
        console.error('Error al obtener la configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener la configuración.' });
    }
});


// Ruta para actualizar la configuración
app.post('/api/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        let config = await readJsonFile(CONFIG_FILE, {});

        // Manejar el caso de bloqueo de página
        if (typeof newConfig.pagina_bloqueada === 'boolean') {
            config.pagina_bloqueada = newConfig.pagina_bloqueada;
            console.log(`Página bloqueada: ${config.pagina_bloqueada}`);
        }

        // Actualizar otros campos si existen en el body
        if (typeof newConfig.tasa_dolar === 'number') {
            config.tasa_dolar = newConfig.tasa_dolar;
        }
        if (typeof newConfig.fecha_sorteo === 'string') {
            config.fecha_sorteo = newConfig.fecha_sorteo;
        }
        if (typeof newConfig.precio_ticket === 'number') {
            config.precio_ticket = newConfig.precio_ticket;
        }
        if (typeof newConfig.numero_sorteo_correlativo === 'number') {
            config.numero_sorteo_correlativo = newConfig.numero_sorteo_correlativo;
        }
        if (typeof newConfig.ultimo_numero_ticket === 'number') {
            config.ultimo_numero_ticket = newConfig.ultimo_numero_ticket;
        }
        if (newConfig.ultima_fecha_resultados_zulia !== undefined) {
            config.ultima_fecha_resultados_zulia = newConfig.ultima_fecha_resultados_zulia;
        }
        if (Array.isArray(newConfig.admin_whatsapp_numbers)) {
            config.admin_whatsapp_numbers = newConfig.admin_whatsapp_numbers;
        }
        if (newConfig.admin_email_for_reports !== undefined) {
            config.admin_email_for_reports = newConfig.admin_email_for_reports;
        }
        if (typeof newConfig.mail_config === 'object' && newConfig.mail_config !== null) {
            config.mail_config = { ...config.mail_config, ...newConfig.mail_config };
            // Re-initialize transporter if mail config changes
            await initializeEmailConfig();
        }

        await writeJsonFile(CONFIG_FILE, config);
        res.json({ message: 'Configuración actualizada exitosamente.', config });
    } catch (error) {
        console.error('Error al actualizar la configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar la configuración.' });
    }
});

// Rutas para números disponibles (CRUD)
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await readJsonFile(NUMEROS_FILE);
        res.json(numeros);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener números disponibles.' });
    }
});

app.post('/api/numeros', async (req, res) => {
    try {
        const newNumeros = req.body;
        await writeJsonFile(NUMEROS_FILE, newNumeros);
        res.status(201).json({ message: 'Números actualizados exitosamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar números disponibles.' });
    }
});

// Rutas para ventas (CRUD)
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        res.json(ventas);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener ventas.' });
    }
});

app.post('/api/ventas', async (req, res) => {
    try {
        const nuevaVenta = req.body;
        const ventas = await readJsonFile(VENTAS_FILE);
        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);

        // Actualizar ultimo_numero_ticket en la configuración
        let config = await readJsonFile(CONFIG_FILE);
        config.ultimo_numero_ticket = Math.max(config.ultimo_numero_ticket || 0, nuevaVenta.nro_ticket);
        await writeJsonFile(CONFIG_FILE, config);

        res.status(201).json({ message: 'Venta registrada exitosamente.', venta: nuevaVenta });
    } catch (error) {
        console.error('Error al registrar venta:', error);
        res.status(500).json({ message: 'Error al registrar venta.', error: error.message });
    }
});


// Rutas para comprobantes (CRUD)
app.get('/api/comprobantes', async (req, res) => {
    try {
        const comprobantes = await readJsonFile(COMPROBANTES_FILE);
        res.json(comprobantes);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener comprobantes.' });
    }
});

app.post('/api/upload-comprobante', fileUpload(), async (req, res) => {
    try {
        if (!req.files || !req.files.comprobante) {
            return res.status(400).json({ message: 'No se subió ningún archivo.' });
        }

        const comprobanteFile = req.files.comprobante;
        const uploadDir = path.join(__dirname, 'uploads');
        await fs.mkdir(uploadDir, { recursive: true }); // Asegura que la carpeta 'uploads' exista

        const fileName = `${Date.now()}_${comprobanteFile.name}`;
        const filePath = path.join(uploadDir, fileName);

        await comprobanteFile.mv(filePath);

        const comprobantes = await readJsonFile(COMPROBANTES_FILE);
        const newComprobante = {
            id: comprobantes.length > 0 ? Math.max(...comprobantes.map(c => c.id)) + 1 : 1,
            comprobante_nombre: fileName,
            comprobante_tipo: comprobanteFile.mimetype,
            fecha_carga: new Date().toISOString()
        };
        comprobantes.push(newComprobante);
        await writeJsonFile(COMPROBANTES_FILE, comprobantes);

        res.status(201).json({ message: 'Comprobante subido exitosamente.', comprobante: newComprobante });
    } catch (error) {
        console.error('Error al subir comprobante:', error);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.', error: error.message });
    }
});


// Rutas para horarios de Zulia
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horarios = await readJsonFile(HORARIOS_ZULIA_FILE);
        res.json(horarios);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener horarios de Zulia.' });
    }
});

app.post('/api/horarios-zulia', async (req, res) => {
    try {
        const newHorarios = req.body;
        await writeJsonFile(HORARIOS_ZULIA_FILE, newHorarios);
        res.status(201).json({ message: 'Horarios de Zulia actualizados exitosamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar horarios de Zulia.' });
    }
});

// Rutas para resultados de Zulia
app.get('/api/resultados-zulia', async (req, res) => {
    try {
        const resultados = await readJsonFile(RESULTADOS_ZULIA_FILE);
        res.json(resultados);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener resultados de Zulia.' });
    }
});

app.post('/api/resultados-zulia', async (req, res) => {
    try {
        const newResultado = req.body; // Se espera { fecha: 'YYYY-MM-DD', resultados: { '12:00 PM': 'XXX', '04:00 PM': 'YYY', '07:00 PM': 'ZZZ' } }
        const resultados = await readJsonFile(RESULTADOS_ZULIA_FILE);

        // Buscar si ya existe un resultado para esa fecha y actualizarlo
        const index = resultados.findIndex(r => r.fecha === newResultado.fecha);
        if (index > -1) {
            resultados[index] = newResultado;
        } else {
            resultados.push(newResultado);
        }
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultados);

        // Opcional: Actualizar ultima_fecha_resultados_zulia en la configuración
        let config = await readJsonFile(CONFIG_FILE);
        config.ultima_fecha_resultados_zulia = newResultado.fecha;
        await writeJsonFile(CONFIG_FILE, config);

        res.status(201).json({ message: 'Resultado de Zulia actualizado/guardado exitosamente.' });
    } catch (error) {
        console.error('Error al actualizar/guardar resultado de Zulia:', error);
        res.status(500).json({ message: 'Error al actualizar/guardar resultado de Zulia.', error: error.message });
    }
});


// Función para generar Excel de ventas
async function generateSalesExcel(salesData, type = 'daily') {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ventas');

    // Add headers based on sales data structure
    worksheet.columns = [
        { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
        { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
        { header: 'Número Comprobante', key: 'nro_comprobante', width: 20 },
        { header: 'Número Ticket', key: 'nro_ticket', width: 15 },
        { header: 'Comprador', key: 'nombre_comprador', width: 30 },
        { header: 'Teléfono', key: 'telefono_comprador', width: 20 },
        { header: 'Números Comprados', key: 'numeros_comprados', width: 40 },
        { header: 'Valor USD', key: 'valor_usd', width: 15 },
        { header: 'Valor Bs', key: 'valor_bs', width: 15 },
        { header: 'Método Pago', key: 'metodo_pago', width: 20 },
        { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
        { header: 'Comprobante', key: 'comprobante_adjunto', width: 30 },
    ];

    salesData.forEach(sale => {
        worksheet.addRow({
            fecha_hora_compra: moment(sale.timestamp).tz('America/Caracas').format('DD-MM-YYYY HH:mm:ss'),
            fecha_sorteo: moment(sale.fecha_sorteo).format('DD-MM-YYYY'),
            nro_comprobante: sale.id_comprobante,
            nro_ticket: sale.nro_ticket,
            nombre_comprador: sale.nombre_comprador,
            telefono_comprador: sale.telefono_comprador,
            numeros_comprados: sale.numeros_comprados.join(', '),
            valor_usd: sale.total_usd,
            valor_bs: sale.total_bs,
            metodo_pago: sale.metodo_pago,
            referencia_pago: sale.referencia_pago,
            comprobante_adjunto: sale.comprobante_adjunto_url || 'N/A' // Si tienes URL de comprobante
        });
    });

    return await workbook.xlsx.writeBuffer();
}

// Ruta para el corte de ventas diario
app.post('/api/corte-ventas-diario', async (req, res) => {
    try {
        const config = await readJsonFile(CONFIG_FILE);
        const ventas = await readJsonFile(VENTAS_FILE);
        const numeros = await readJsonFile(NUMEROS_FILE); // Leer números para reiniciar

        const now = moment().tz('America/Caracas');
        const yesterday = now.clone().subtract(1, 'days').format('YYYY-MM-DD'); // Fecha del día anterior para el corte

        // Filtrar ventas del día actual o las que no tienen fecha_corte
        const ventasParaCorte = ventas.filter(venta => {
            const ventaDate = moment(venta.timestamp).tz('America/Caracas').format('YYYY-MM-DD');
            return ventaDate === yesterday && !venta.fecha_corte; // Asegúrate de que no se haya cortado ya
        });

        if (ventasParaCorte.length === 0) {
            return res.status(200).json({ message: 'No hay ventas para el corte de ayer.', ventas_cortadas_count: 0 });
        }

        // Marcar ventas como cortadas y asignar fecha de corte
        const ventasActualizadas = ventas.map(venta => {
            const ventaDate = moment(venta.timestamp).tz('America/Caracas').format('YYYY-MM-DD');
            if (ventaDate === yesterday && !venta.fecha_corte) {
                return { ...venta, fecha_corte: now.format('YYYY-MM-DD HH:mm:ss') };
            }
            return venta;
        });

        await writeJsonFile(VENTAS_FILE, ventasActualizadas);

        // Generar Excel del corte
        const buffer = await generateSalesExcel(ventasParaCorte, 'diario');

        // Enviar correo con el informe
        const adminEmail = config.admin_email_for_reports;
        if (adminEmail) {
            const htmlContent = `
                <p>Estimado administrador,</p>
                <p>Se ha realizado el corte de ventas diario para el día **${yesterday}**.</p>
                <p>Se adjunta el informe de ventas correspondientes a este corte.</p>
                <p>Total de ventas cortadas: ${ventasParaCorte.length}</p>
                <p>Gracias por su atención.</p>
                <p>Saludos cordiales,</p>
                <p>El equipo de su Sistema de Rifas</p>
            `;
            await sendEmail(
                adminEmail,
                `Informe de Corte de Ventas Diario - ${yesterday}`,
                htmlContent,
                [{ filename: `Corte_Ventas_${yesterday}.xlsx`, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
            );
            console.log(`Correo de corte de ventas enviado a ${adminEmail}`);
        } else {
            console.warn('No se ha configurado un correo de administrador para reportes.');
        }

        // Reiniciar números disponibles para el próximo sorteo
        const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
        console.log('Números disponibles reiniciados para el próximo sorteo.');

        // Actualizar la fecha del próximo sorteo a mañana
        const nextDrawDate = now.clone().add(1, 'days').format('YYYY-MM-DD');
        config.fecha_sorteo = nextDrawDate;
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
        await writeJsonFile(CONFIG_FILE, config);
        console.log(`Fecha del próximo sorteo actualizada a: ${nextDrawDate}`);

        res.status(200).json({ message: 'Corte de ventas diario realizado y enviado por correo. Números reiniciados y fecha de sorteo actualizada.', ventas_cortadas_count: ventasParaCorte.length });

    } catch (error) {
        console.error('Error al realizar el corte de ventas diario:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar el corte de ventas diario.', error: error.message });
    }
});


// Ruta para exportar todas las ventas a Excel
app.get('/api/exportar-ventas-excel', async (req, res) => {
    try {
        const ventas = await readJsonFile(VENTAS_FILE);
        const buffer = await generateSalesExcel(ventas, 'todas');

        res.setHeader('Content-Disposition', 'attachment; filename="Todas_Ventas_Sistema_Rifas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas a Excel.', error: error.message });
    }
});


app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use((req, res, next) => {
    res.status(404).json({ message: 'Ruta no encontrada.', path: req.path, method: req.method });
});

app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack);
    res.status(500).json({ message: 'Ocurrió un error inesperado en el servidor.', error: err.message });
});

app.listen(port, async () => {
    console.log(`Servidor de backend escuchando en http://localhost:${port}`);
    await initializeEmailConfig();
});

// Programar la tarea de corte de ventas para que se ejecute a la medianoche (00:00) cada día
cron.schedule('0 0 * * *', async () => { // Se ejecuta a las 00:00 (medianoche) todos los días
    console.log('✨ Ejecutando tarea programada: Corte de ventas automático.');
    try {
        const config = await readJsonFile(CONFIG_FILE);
        const ventas = await readJsonFile(VENTAS_FILE);
        const numeros = await readJsonFile(NUMEROS_FILE); // Leer números para reiniciar

        const now = moment().tz('America/Caracas');
        const yesterday = now.clone().subtract(1, 'days').format('YYYY-MM-DD'); // Fecha del día anterior para el corte

        // Filtrar ventas del día anterior que aún no han sido cortadas
        const ventasParaCorte = ventas.filter(venta => {
            const ventaDate = moment(venta.timestamp).tz('America/Caracas').format('YYYY-MM-DD');
            return ventaDate === yesterday && !venta.fecha_corte;
        });

        if (ventasParaCorte.length === 0) {
            console.log('No hay ventas para el corte automático de ayer.');
            return;
        }

        // Marcar ventas como cortadas y asignar fecha de corte
        const ventasActualizadas = ventas.map(venta => {
            const ventaDate = moment(venta.timestamp).tz('America/Caracas').format('YYYY-MM-DD');
            if (ventaDate === yesterday && !venta.fecha_corte) {
                return { ...venta, fecha_corte: now.format('YYYY-MM-DD HH:mm:ss') };
            }
            return venta;
        });
        await writeJsonFile(VENTAS_FILE, ventasActualizadas);

        // Generar Excel del corte
        const buffer = await generateSalesExcel(ventasParaCorte, 'diario');

        // Enviar correo con el informe
        const adminEmail = config.admin_email_for_reports;
        if (adminEmail) {
            const htmlContent = `
                <p>Estimado administrador,</p>
                <p>Se ha realizado el corte de ventas automático para el día **${yesterday}**.</p>
                <p>Se adjunta el informe de ventas correspondientes a este corte.</p>
                <p>Total de ventas cortadas: ${ventasParaCorte.length}</p>
                <p>Gracias por su atención.</p>
                <p>Saludos cordiales,</p>
                <p>El equipo de su Sistema de Rifas</p>
            `;
            await sendEmail(
                adminEmail,
                `Informe de Corte de Ventas Automático - ${yesterday}`,
                htmlContent,
                [{ filename: `Corte_Ventas_${yesterday}.xlsx`, content: buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
            );
            console.log(`Correo de corte de ventas automático enviado a ${adminEmail}`);
        } else {
            console.warn('No se ha configurado un correo de administrador para reportes en la configuración.');
        }

        // Reiniciar números disponibles para el próximo sorteo
        const numerosReiniciados = Array.from({ length: 100 }, (_, i) => ({
            numero: i.toString().padStart(2, '0'),
            comprado: false
        }));
        await writeJsonFile(NUMEROS_FILE, numerosReiniciados);
        console.log('Números disponibles reiniciados automáticamente para el próximo sorteo.');

        // Actualizar la fecha del próximo sorteo a mañana y el correlativo
        const nextDrawDate = now.clone().add(1, 'days').format('YYYY-MM-DD');
        config.fecha_sorteo = nextDrawDate;
        config.numero_sorteo_correlativo = (config.numero_sorteo_correlativo || 0) + 1; // Incrementa el número de sorteo
        await writeJsonFile(CONFIG_FILE, config);
        console.log(`Fecha del próximo sorteo actualizada automáticamente a: ${nextDrawDate}`);


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas:', error);
    }
}, {
    timezone: "America/Caracas" // Asegura que se ejecute en la zona horaria de Venezuela
});