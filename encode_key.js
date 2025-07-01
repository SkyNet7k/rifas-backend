const fs = require('fs');
const path = require('path');

// Reemplaza 'tuoportunidadeshoy-5ec06-firebase-adminsdk-fbsvc-0bb1210c21.json'
// con el nombre exacto de tu archivo de clave privada si es diferente.
const serviceAccountKeyPath = path.join(__dirname, 'tuoportunidadeshoy-5ec06-firebase-adminsdk-fbsvc-0bb1210c21.json');

try {
    const serviceAccountJson = fs.readFileSync(serviceAccountKeyPath, 'utf8');
    const serviceAccountBase64 = Buffer.from(serviceAccountJson).toString('base64');
    console.log('Tu clave privada codificada en Base64 es:');
    console.log(serviceAccountBase64);
} catch (error) {
    console.error('Error al leer o codificar el archivo:', error);
    console.error('Asegúrate de que el archivo JSON de tu clave privada esté en el mismo directorio que este script y que el nombre del archivo sea correcto.');
}
