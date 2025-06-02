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

// RUTAS CORREGIDAS: Ahora los archivos JSON se buscan directamente en el directorio __dirname
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const COMPROBANTES_REGISTRO_FILE = path.join(__dirname, 'comprobantes.json'); // Archivo para registrar comprobantes finalizados

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Variables globales para los datos (se inicializan al inicio)
let configuracion;
let numerosDisponibles;
let ventasRealizadas;
let horariosZulia;
let resultadosZulia;
let comprobantesRegistros;

// --- Funciones de Utilidad para manejo de archivos JSON ---
async function readJsonFile(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Se creará con el valor por defecto.`);
            await writeJsonFile(filePath, defaultValue);
            return defaultValue;
        } else if (error.name === 'SyntaxError') {
            console.error(`Error de sintaxis JSON en ${filePath}:`, error.message);
            console.warn(`Se sobrescribirá ${filePath} con el valor por defecto para corregir el error.`);
            await writeJsonFile(filePath, defaultValue);
            return defaultValue;
        } else {
            console.error(`Error al leer el archivo ${filePath}:`, error);
            throw error;
        }
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir en el archivo ${filePath}:`, error);
        throw error;
    }
}

// --- Lógica de Inicialización de Datos ---
async function loadInitialData() {
    try {
        // Cargar configuración o usar valores por defecto (incluyendo mail_config y admin_email)
        configuracion = await readJsonFile(CONFIG_FILE, {
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
                user: "SkyFall7k@gmail.com", // Aquí tus credenciales
                pass: "gnrl fxqe oqpd twti", // Aquí tu contraseña de aplicación de Google
                senderName: "Sistema de Rifas"
            },
            admin_email_for_reports: "SkyFall7k@gmail.com" // Aquí tu correo para reportes
        });

        // Generar números del 000 al 999 como disponibles si el archivo no existe o está vacío
        const defaultNumeros = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
        numerosDisponibles = await readJsonFile(NUMEROS_FILE, defaultNumeros);
        // Si por alguna razón el archivo existe pero está vacío o no es un array, reiniciarlo
        if (!Array.isArray(numerosDisponibles) || numerosDisponibles.length === 0) {
            console.warn('numeros.json vacío o corrupto. Reiniciando con todos los números disponibles.');
            numerosDisponibles = defaultNumeros;
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles);
        }

        ventasRealizadas = await readJsonFile(VENTAS_FILE, []);
        if (!Array.isArray(ventasRealizadas)) ventasRealizadas = [];

        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, ["13:00", "15:00", "17:00", "19:00"]);
        if (!Array.isArray(horariosZulia)) horariosZulia = ["13:00", "15:00", "17:00", "19:00"];

        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        if (!Array.isArray(resultadosZulia)) resultadosZulia = [];

        comprobantesRegistros = await readJsonFile(COMPROBANTES_REGISTRO_FILE, []);
        if (!Array.isArray(comprobantesRegistros)) comprobantesRegistros = [];


        console.log('Datos iniciales cargados con éxito.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
        // Si hay un error crítico al cargar los datos iniciales, el servidor no debería iniciar
        throw error;
    }
}

// Función para generar un ID único
function generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Función para enviar correos electrónicos
async function sendEmail(to, subject, htmlContent, attachments = []) {
    const mailConfig = configuracion.mail_config;

    if (!mailConfig || !mailConfig.user || !mailConfig.pass || !mailConfig.host) {
        console.error('Configuración de correo incompleta. No se puede enviar el email.');
        return false;
    }

    try {
        let transporter = nodemailer.createTransport({
            host: mailConfig.host,
            port: mailConfig.port,
            secure: mailConfig.secure, // true for 465, false for other ports
            auth: {
                user: mailConfig.user,
                pass: mailConfig.pass,
            },
        });

        let info = await transporter.sendMail({
            from: `"${mailConfig.senderName}" <${mailConfig.user}>`,
            to: to,
            subject: subject,
            html: htmlContent,
            attachments: attachments,
        });

        console.log("Mensaje enviado: %s", info.messageId);
        return true;
    } catch (error) {
        console.error("Error al enviar el correo:", error);
        return false;
    }
}

// --- Rutas de la API ---

// Ruta para obtener la configuración actual
app.get('/api/configuracion', (req, res) => {
    // No enviar la contraseña de correo en la configuración
    const configToSend = { ...configuracion };
    if (configToSend.mail_config) {
        delete configToSend.mail_config.pass;
    }
    res.json(configToSend);
});

// Ruta para actualizar la configuración (Solo para panel de administración)
app.post('/api/admin/configuracion', async (req, res) => {
    try {
        const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo, admin_whatsapp_numbers, admin_email_for_reports } = req.body;

        if (tasa_dolar !== undefined) configuracion.tasa_dolar = parseFloat(tasa_dolar);
        if (pagina_bloqueada !== undefined) configuracion.pagina_bloqueada = Boolean(pagina_bloqueada);
        if (fecha_sorteo) configuracion.fecha_sorteo = fecha_sorteo;
        if (precio_ticket !== undefined) configuracion.precio_ticket = parseFloat(precio_ticket);
        if (numero_sorteo_correlativo !== undefined) configuracion.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo);
        if (admin_whatsapp_numbers && Array.isArray(admin_whatsapp_numbers)) configuracion.admin_whatsapp_numbers = admin_whatsapp_numbers;
        if (admin_email_for_reports) configuracion.admin_email_for_reports = admin_email_for_reports;


        await writeJsonFile(CONFIG_FILE, configuracion);
        res.status(200).json({ message: 'Configuración actualizada con éxito.', configuracion });
    } catch (error) {
        console.error('Error al actualizar la configuración:', error);
        res.status(500).json({ error: 'Error interno del servidor al actualizar la configuración.' });
    }
});


// Ruta para obtener números disponibles
app.get('/api/numeros-disponibles', (req, res) => {
    if (configuracion.pagina_bloqueada) {
        return res.status(200).json({ blocked: true, message: 'La plataforma está actualmente bloqueada.' });
    }
    res.json({
        numerosDisponibles: numerosDisponibles,
        precioTicket: configuracion.precio_ticket,
        tasaDolar: configuracion.tasa_dolar,
        fechaSorteo: configuracion.fecha_sorteo,
        numeroSorteoCorrelativo: configuracion.numero_sorteo_correlativo,
        paginaBloqueada: configuracion.pagina_bloqueada
    });
});

// Ruta para comprar tickets
app.post('/api/comprar-ticket', async (req, res) => {
    try {
        if (configuracion.pagina_bloqueada) {
            return res.status(403).json({ error: 'La plataforma está actualmente bloqueada y no se pueden realizar compras.' });
        }

        const {
            numeros,
            nombre_apellido,
            telefono,
            metodo_pago,
            referencia_pago,
            valor_usd,
            valor_bs,
            fecha_sorteo,
            numero_sorteo_correlativo
        } = req.body;

        if (!numeros || !Array.isArray(numeros) || numeros.length === 0) {
            return res.status(400).json({ error: 'Debe seleccionar al menos un número.' });
        }

        const now = moment().tz("America/Caracas");
        const fechaHoraCompra = now.format('YYYY-MM-DD HH:mm:ss');
        const numeroTicket = `T-${now.format('YYYYMMDDHHmmss')}-${String(configuracion.ultimo_numero_ticket + 1).padStart(4, '0')}`;
        configuracion.ultimo_numero_ticket += 1;
        await writeJsonFile(CONFIG_FILE, configuracion); // Actualizar el último número de ticket

        // Verificar si los números seleccionados están realmente disponibles
        const numerosNoDisponibles = numeros.filter(num => !numerosDisponibles.includes(num));
        if (numerosNoDisponibles.length > 0) {
            return res.status(400).json({ error: `Los siguientes números no están disponibles: ${numerosNoDisponibles.join(', ')}. Por favor, recargue la página.` });
        }

        // Marcar números como ocupados
        numerosDisponibles = numerosDisponibles.filter(num => !numeros.includes(num));
        await writeJsonFile(NUMEROS_FILE, numerosDisponibles);

        const nuevaVenta = {
            id_venta: generateUniqueId(),
            fecha_hora_compra: fechaHoraCompra,
            fecha_sorteo: fecha_sorteo,
            numero_sorteo: numero_sorteo_correlativo,
            numero_ticket: numeroTicket,
            comprador: nombre_apellido,
            telefono: telefono,
            numeros: numeros,
            valor_usd: parseFloat(valor_usd),
            valor_bs: parseFloat(valor_bs),
            metodo_pago: metodo_pago,
            referencia_pago: referencia_pago,
            estado: 'pendiente_comprobante', // Estado inicial
            url_comprobante: null // Se llenará al subir el comprobante
        };

        ventasRealizadas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventasRealizadas);

        res.status(201).json({ message: 'Compra registrada con éxito.', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al registrar la compra:', error);
        res.status(500).json({ error: 'Error interno del servidor al procesar la compra.' });
    }
});


// Ruta para subir comprobante
app.post('/api/subir-comprobante/:id_venta', async (req, res) => {
    try {
        const { id_venta } = req.params;

        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ error: 'No se ha subido ningún archivo.' });
        }

        const comprobanteFile = req.files.comprobante;
        const now = moment().tz("America/Caracas");
        const uploadDir = path.join(__dirname, 'comprobantes'); // Directorio donde se guardarán
        await fs.mkdir(uploadDir, { recursive: true }); // Asegura que el directorio exista

        // Renombrar el archivo para evitar conflictos y facilitar la búsqueda
        const fileName = `${id_venta}_${now.format('YYYYMMDD_HHmmss')}${path.extname(comprobanteFile.name)}`;
        const filePath = path.join(uploadDir, fileName);

        await comprobanteFile.mv(filePath); // Guarda el archivo en el servidor

        const ventaIndex = ventasRealizadas.findIndex(venta => venta.id_venta === id_venta);

        if (ventaIndex > -1) {
            // Generar URL pública para el comprobante
            // Asume que Render o tu hosting sirve archivos estáticos desde /comprobantes/
            const comprobanteUrl = `${API_BASE_URL}/comprobantes/${fileName}`;
            ventasRealizadas[ventaIndex].url_comprobante = comprobanteUrl;
            ventasRealizadas[ventaIndex].estado = 'comprobante_subido';
            await writeJsonFile(VENTAS_FILE, ventasRealizadas);

            // Registrar el comprobante como finalizado
            const nuevoRegistroComprobante = {
                id_registro: generateUniqueId(),
                id_venta: id_venta,
                comprador: ventasRealizadas[ventaIndex].comprador,
                telefono: ventasRealizadas[ventaIndex].telefono,
                numeros: ventasRealizadas[ventaIndex].numeros,
                metodo_pago: ventasRealizadas[ventaIndex].metodo_pago,
                referencia_pago: ventasRealizadas[ventaIndex].referencia_pago,
                fecha_hora_finalizacion: now.format('YYYY-MM-DD HH:mm:ss'),
                fecha_sorteo: ventasRealizadas[ventaIndex].fecha_sorteo,
                nro_sorteo: ventasRealizadas[ventaIndex].numero_sorteo,
                url: comprobanteUrl,
                url_comprobante_original_venta: null // No tiene un comprobante de venta original diferente si se finaliza aquí
            };
            comprobantesRegistros.push(nuevoRegistroComprobante);
            await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);


            // Enviar notificación a WhatsApp de los administradores
            for (const adminPhone of configuracion.admin_whatsapp_numbers) {
                const message = `¡Nuevo comprobante subido!\n\nID Venta: ${id_venta}\nComprador: ${ventasRealizadas[ventaIndex].comprador}\nNúmeros: ${ventasRealizadas[ventaIndex].numeros.join(', ')}\nValor: $${ventasRealizadas[ventaIndex].valor_usd.toFixed(2)} / Bs.${ventasRealizadas[ventaIndex].valor_bs.toFixed(2)}\nMétodo: ${ventasRealizadas[ventaIndex].metodo_pago}\nReferencia: ${ventasRealizadas[ventaIndex].referencia_pago}\nComprobante: ${comprobanteUrl}`;
                const whatsappUrl = `https://api.whatsapp.com/send?phone=${adminPhone}&text=${encodeURIComponent(message)}`;
                console.log(`URL de WhatsApp para admin ${adminPhone}: ${whatsappUrl}`); // Solo para depuración
                // En un entorno real, tendrías que usar una API de WhatsApp para enviar esto automáticamente.
                // Aquí solo estamos generando la URL.
            }

            // Enviar correo al administrador con el comprobante adjunto
            const emailSubject = `Comprobante Subido para Venta ${id_venta}`;
            const emailHtml = `
                <p>Se ha subido un nuevo comprobante para la venta con ID <strong>${id_venta}</strong>.</p>
                <p><strong>Comprador:</strong> ${ventasRealizadas[ventaIndex].comprador}</p>
                <p><strong>Teléfono:</strong> ${ventasRealizadas[ventaIndex].telefono}</p>
                <p><strong>Números:</strong> ${ventasRealizadas[ventaIndex].numeros.join(', ')}</p>
                <p><strong>Valor USD:</strong> $${ventasRealizadas[ventaIndex].valor_usd.toFixed(2)}</p>
                <p><strong>Valor Bs:</strong> Bs.${ventasRealizadas[ventaIndex].valor_bs.toFixed(2)}</p>
                <p><strong>Método de Pago:</strong> ${ventasRealizadas[ventaIndex].metodo_pago}</p>
                <p><strong>Referencia de Pago:</strong> ${ventasRealizadas[ventaIndex].referencia_pago}</p>
                <p>Puedes ver el comprobante <a href="${comprobanteUrl}">aquí</a>.</p>
            `;
            await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtml, [{ path: filePath, filename: fileName }]);


            res.status(200).json({ message: 'Comprobante subido y venta actualizada con éxito.', url: comprobanteUrl });
        } else {
            res.status(404).json({ error: 'Venta no encontrada.' });
        }
    } catch (error) {
        console.error('Error al subir el comprobante:', error);
        res.status(500).json({ error: 'Error interno del servidor al subir el comprobante.' });
    }
});


// Ruta para obtener todas las ventas (Solo para panel de administración)
app.get('/api/admin/ventas', (req, res) => {
    res.json(ventasRealizadas);
});

// Ruta para finalizar una venta por el administrador (registrando el comprobante en otro JSON)
app.post('/api/admin/finalizar-venta', async (req, res) => {
    try {
        const { id_venta } = req.body;

        const ventaIndex = ventasRealizadas.findIndex(v => v.id_venta === id_venta);

        if (ventaIndex === -1) {
            return res.status(404).json({ error: 'Venta no encontrada.' });
        }

        const ventaAFinalizar = ventasRealizadas[ventaIndex];
        const now = moment().tz("America/Caracas");

        // Crear un registro en el array de comprobantes finalizados
        const nuevoRegistroComprobante = {
            id_registro: generateUniqueId(),
            id_venta: ventaAFinalizar.id_venta,
            comprador: ventaAFinalizar.comprador,
            telefono: ventaAFinalizar.telefono,
            numeros: ventaAFinalizar.numeros,
            metodo_pago: ventaAFinalizar.metodo_pago,
            referencia_pago: ventaAFinalizar.referencia_pago,
            fecha_hora_finalizacion: now.format('YYYY-MM-DD HH:mm:ss'),
            fecha_sorteo: ventaAFinalizar.fecha_sorteo,
            nro_sorteo: ventaAFinalizar.numero_sorteo,
            url: ventaAFinalizar.url_comprobante || null, // Usar el URL si ya existe
            url_comprobante_original_venta: ventaAFinalizar.url_comprobante || null // Guardar el URL original de la venta
        };

        comprobantesRegistros.push(nuevoRegistroComprobante);
        await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);

        // Eliminar la venta de ventasRealizadas
        ventasRealizadas.splice(ventaIndex, 1);
        await writeJsonFile(VENTAS_FILE, ventasRealizadas);

        res.status(200).json({ message: 'Venta finalizada y registrada con éxito.' });

    } catch (error) {
        console.error('Error al finalizar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al finalizar la venta.' });
    }
});

// Ruta para obtener todos los comprobantes finalizados
app.get('/api/admin/comprobantes-finalizados', (req, res) => {
    res.json(comprobantesRegistros);
});

// Ruta para exportar ventas a Excel
app.get('/api/admin/exportar-ventas', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        // Definir columnas
        worksheet.columns = [
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 20 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo', width: 10 },
            { header: 'Nro. Ticket', key: 'numero_ticket', width: 15 },
            { header: 'Comprador', key: 'comprador', width: 25 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Números', key: 'numeros', width: 30 },
            { header: 'Valor USD', key: 'valor_usd', width: 10 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 20 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 40 }
        ];

        // Añadir filas
        ventasRealizadas.forEach(venta => {
            worksheet.addRow({
                fecha_hora_compra: venta.fecha_hora_compra,
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo: venta.numero_sorteo,
                numero_ticket: venta.numero_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros ? venta.numeros.join(', ') : '',
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                url_comprobante: venta.url_comprobante
            });
        });

        // Configurar respuesta HTTP
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_ventas_${moment().format('YYYYMMDD_HHmmss')}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ error: 'Error interno del servidor al exportar ventas a Excel.' });
    }
});


// Rutas para Horarios Zulia (Panel de administración)
app.get('/api/admin/horarios-zulia', (req, res) => {
    res.json(horariosZulia);
});

app.post('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const { nuevoHorario } = req.body;
        if (nuevoHorario && !horariosZulia.includes(nuevoHorario)) {
            horariosZulia.push(nuevoHorario);
            horariosZulia.sort(); // Opcional: mantener ordenados
            await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
            return res.status(200).json({ message: 'Horario añadido con éxito.', horarios: horariosZulia });
        }
        res.status(400).json({ error: 'Horario ya existe o es inválido.' });
    } catch (error) {
        console.error('Error al añadir horario:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.delete('/api/admin/horarios-zulia/:horario', async (req, res) => {
    try {
        const { horario } = req.params;
        const initialLength = horariosZulia.length;
        horariosZulia = horariosZulia.filter(h => h !== horario);
        if (horariosZulia.length < initialLength) {
            await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
            return res.status(200).json({ message: 'Horario eliminado con éxito.', horarios: horariosZulia });
        }
        res.status(404).json({ error: 'Horario no encontrado.' });
    } catch (error) {
        console.error('Error al eliminar horario:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});


// Rutas para Resultados Zulia (Panel de administración)
app.get('/api/admin/resultados-zulia', (req, res) => {
    res.json(resultadosZulia);
});

app.post('/api/admin/resultados-zulia', async (req, res) => {
    try {
        const { fecha, horario, resultado, tipo } = req.body;
        if (!fecha || !horario || resultado === undefined || !tipo) {
            return res.status(400).json({ error: 'Todos los campos son requeridos para el resultado.' });
        }

        const existingResultIndex = resultadosZulia.findIndex(r => r.fecha === fecha && r.horario === horario && r.tipo === tipo);

        if (existingResultIndex !== -1) {
            resultadosZulia[existingResultIndex].resultado = resultado;
            console.log(`Resultado actualizado para ${fecha} ${horario} ${tipo}.`);
        } else {
            resultadosZulia.push({ fecha, horario, resultado, tipo });
            console.log(`Nuevo resultado añadido para ${fecha} ${horario} ${tipo}.`);
        }

        // Mantener solo los resultados de los últimos 30 días para evitar que el archivo crezca demasiado
        const thirtyDaysAgo = moment().tz("America/Caracas").subtract(30, 'days').startOf('day');
        resultadosZulia = resultadosZulia.filter(r => moment(r.fecha).isSameOrAfter(thirtyDaysAgo));
        resultadosZulia.sort((a, b) => {
            if (a.fecha === b.fecha) {
                return a.horario.localeCompare(b.horario);
            }
            return moment(a.fecha).diff(moment(b.fecha));
        });

        configuracion.ultima_fecha_resultados_zulia = moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss');
        await writeJsonFile(CONFIG_FILE, configuracion);
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);

        res.status(200).json({ message: 'Resultado de Zulia guardado con éxito.', resultados: resultadosZulia });
    } catch (error) {
        console.error('Error al guardar resultado de Zulia:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});


// CRON Job para reinicio de números y corte de ventas a medianoche
cron.schedule('0 0 * * *', async () => { // Se ejecuta todos los días a las 00:00 (medianoche)
    console.log('Ejecutando tarea programada: corte de ventas y reinicio de números.');
    try {
        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');
        const currentDrawDate = configuracion.fecha_sorteo;

        // Si la fecha de sorteo actual es anterior a hoy, reiniciar números y actualizar fecha
        if (moment(currentDrawDate).isBefore(todayFormatted)) {
            // Guardar las ventas realizadas hasta el momento en un archivo de historial si lo deseas
            // Por ahora, solo se reinician los números y las ventas activas se borran
            console.log('Reiniciando números disponibles y ventas para el nuevo sorteo.');

            // Reiniciar números disponibles a todos los números del 000 al 999
            numerosDisponibles = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles);

            // Vaciar las ventas realizadas del sorteo anterior
            ventasRealizadas = [];
            await writeJsonFile(VENTAS_FILE, ventasRealizadas);

            // Actualizar la fecha del sorteo a mañana
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
// Se eliminó ensureDataAndComprobantesDirs() ya que los archivos se crean al cargar datos iniciales
loadInitialData().then(() => {
    app.listen(port, () => {
        console.log(`Servidor de la API escuchando en el puerto ${port}`);
        console.log(`API Base URL: ${API_BASE_URL}`);
        console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`);
        console.log(`Frontend principal disponible en: https://tuoportunidadeshoy.netlify.app`);
    });
}).catch(error => {
    console.error("Fallo crítico al iniciar el servidor:", error);
    process.exit(1); // Salir del proceso si la carga inicial falla
});