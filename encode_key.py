import base64
import os

# Asegúrate de que este nombre sea EXACTAMENTE el de tu archivo JSON de clave de servicio
# Basado en tu 'dir', este es el nombre correcto:
SERVICE_ACCOUNT_FILE = "tu-oportunidad-es-hoy-firebase-adminsdk-fbsvc-781e9f9dc1.json"

if not os.path.exists(SERVICE_ACCOUNT_FILE):
    print(f"Error: Archivo '{SERVICE_ACCOUNT_FILE}' no encontrado en el directorio actual.")
else:
    try:
        with open(SERVICE_ACCOUNT_FILE, "rb") as f:
            encoded_string = base64.b64encode(f.read()).decode("utf-8")
        print("--- COMIENZO DE CLAVE BASE64 ---")
        print(encoded_string)
        print("--- FIN DE CLAVE BASE64 ---")
        print("\nCopia el texto entre '--- COMIENZO ---' y '--- FIN ---' y pégalo en Render.")
    except Exception as e:
        print(f"Error al codificar el archivo: {e}")