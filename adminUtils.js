const moment = require('moment-timezone');

/**
 * Lee un documento específico de una colección en Firestore.
 * @param {Object} db - La instancia de Firestore.
 * @param {string} collectionName - Nombre de la colección.
 * @param {string} docId - ID del documento.
 * @returns {Promise<Object|null>} El objeto del documento o null si no existe.
 */
async function readFirestoreDoc(db, collectionName, docId) {
    try {
        const docRef = db.collection(collectionName).doc(docId);
        const doc = await docRef.get();
        if (doc.exists) {
            return doc.data();
        }
        return null;
    } catch (error) {
        console.error(`Error leyendo documento ${docId} en colección ${collectionName}:`, error);
        return null;
    }
}

/**
 * Escribe o actualiza un documento específico en una colección de Firestore.
 * @param {Object} db - La instancia de Firestore.
 * @param {string} collectionName - Nombre de la colección.
 * @param {string} docId - ID del documento.
 * @param {Object} data - Los datos a guardar.
 * @returns {Promise<boolean>} True si la operación fue exitosa.
 */
async function writeFirestoreDoc(db, collectionName, docId, data) {
    try {
        await db.collection(collectionName).doc(docId).set(data, { merge: true });
        return true;
    } catch (error) {
        console.error(`Error escribiendo documento ${docId} en colección ${collectionName}:`, error);
        return false;
    }
}

/**
 * Define la función asíncrona para manejar la lógica de limpiar datos en Firestore.
 * @param {Object} db - La instancia de Firestore.
 * @param {Object} configuracion - La configuración actual de la aplicación (se usará para valores por defecto si no hay en Firestore).
 * @param {string} CARACAS_TIMEZONE - La zona horaria de Caracas.
 * @param {Function} loadInitialData - Función para recargar los datos iniciales en el servidor principal.
 * @param {Object} res - Objeto de respuesta de Express para enviar la respuesta HTTP.
 * @returns {Promise<void>}
 */
async function handleLimpiarDatos(db, configuracion, CARACAS_TIMEZONE, loadInitialData, res) {
    console.log('API: Recibida solicitud para limpiar todos los datos en Firestore.');
    try {
        const collectionsToClear = ['sales', 'raffle_numbers', 'draw_results', 'winners']; // No limpiar app_config ni lottery_times completamente, solo resetearlos

        for (const collectionName of collectionsToClear) {
            const snapshot = await db.collection(collectionName).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`Colección '${collectionName}' de Firestore limpiada.`);
        }

        // Reiniciar números a su estado inicial en Firestore
        const batchNumbers = db.batch();
        for (let i = 0; i < 1000; i++) {
            const numStr = i.toString().padStart(3, '0');
            const numRef = db.collection('raffle_numbers').doc(numStr);
            batchNumbers.set(numRef, { numero: numStr, comprado: false, originalDrawNumber: null });
        }
        await batchNumbers.commit();
        console.log('Números de rifa reiniciados en Firestore.');

        // Reiniciar configuración principal en Firestore
        // Primero, leer la configuración actual para mantener mail_config, whatsapp_numbers, etc.
        let currentConfigFromFirestore = await readFirestoreDoc(db, 'app_config', 'main_config');
        // Usar la configuración de Firestore si está disponible, de lo contrario, la que está en memoria (cargada de los JSON del usuario)
        const configToPersist = currentConfigFromFirestore || configuracion;

        await writeFirestoreDoc(db, 'app_config', 'main_config', {
            "precio_ticket": 0.50,
            "tasa_dolar": 36.50,
            "fecha_sorteo": moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            "numero_sorteo_correlativo": 1,
            "ultimo_numero_ticket": 0,
            "pagina_bloqueada": false,
            "block_reason_message": "",
            // Mantener la configuración de correo, WhatsApp y email de reportes
            "mail_config": configToPersist.mail_config,
            "admin_whatsapp_numbers": configToPersist.admin_whatsapp_numbers,
            "last_sales_notification_count": 0,
            "sales_notification_threshold": configToPersist.sales_notification_threshold,
            "admin_email_for_reports": configToPersist.admin_email_for_reports,
            "ultima_fecha_resultados_zulia": null,
            "raffleNumbersInitialized": true // Ya se inicializaron, así que se marca como true
        });
        console.log('Configuración principal reiniciada en Firestore.');

        // Reiniciar horarios (siempre deben existir)
        await writeFirestoreDoc(db, 'lottery_times', 'zulia_chance', {
            zulia: ["12:00 PM", "04:00 PM", "07:00 PM"],
            chance: ["01:00 PM", "05:00 PM", "08:00 PM"]
        });
        console.log('Horarios reiniciados en Firestore.');

        // Reiniciar premios (vacío)
        await writeFirestoreDoc(db, 'prizes', 'daily_prizes', {});
        console.log('Premios reiniciados en Firestore.');


        // Recargar solo las cachés que se cargan al inicio después de la limpieza
        // Es crucial que `loadInitialData` actualice la variable `configuracion` global en `server.js`
        // Para esto, `loadInitialData` debería ser una función que recarga las variables globales.
        // Asumiendo que `loadInitialData` en `server.js` maneja esto, la llamamos.
        await loadInitialData();

        res.status(200).json({ success: true, message: 'Todos los datos en Firestore (ventas, números, resultados, ganadores, premios) han sido limpiados y reiniciados.' });
    } catch (error) {
        console.error('Error al limpiar los datos en Firestore:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al limpiar los datos.' });
    }
}

module.exports = {
    handleLimpiarDatos,
    readFirestoreDoc,
    writeFirestoreDoc
};
