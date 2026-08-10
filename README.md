# Suplementos Bot

Bot para:
1. Scrapear los 10 productos configurados.
2. Comparar precios con la ejecución anterior.
3. Enviar una alerta por WhatsApp solamente cuando haya cambios.

## WhatsApp

La sesión se guarda en `storage/baileys_auth`.

- `npm run whatsapp:login` se usa solamente para vincular/revincular.
- `npm run whatsapp:test` prueba el envío.
- `npm run check` nunca muestra QR. Reutiliza la sesión guardada y reintenta hasta 3 veces si WhatsApp corta la conexión.

IMPORTANTE: al reemplazar el proyecto, no borres `storage/baileys_auth` si ya está vinculado.

## Instalación

```bash
npm install
```

## Prueba

```bash
npm run whatsapp:test
npm run check
```

El `.env` incluido ya contiene el número configurado.
