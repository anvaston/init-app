/*
 * ble.js — шар Bluetooth для init_stm (модуль JDY-23).
 *
 * Уся робота з Bluetooth зібрана тут, щоб решта програми (app.js) не залежала
 * від того, де вона запущена:
 *   - у браузері Chrome / Edge (ноутбук, Android) -> Web Bluetooth (готово);
 *   - в Android-застосунку (Capacitor)            -> плагін BLE (додамо на етапі збирання .apk).
 *
 * JDY-23: сервіс FFE0, характеристика FFE1 (запис команд + сповіщення з відповідями).
 * Кожне повідомлення плати приходить окремим сповіщенням, до 20 символів.
 */
const BLE_SERVICE = 0xffe0;
const BLE_CHAR    = 0xffe1;
const BLE_CHUNK   = 20;          // JDY-23 приймає до 20 байт за один запис

const BleLink = (() => {
  let device = null;
  let chr = null;
  let useWithResponse = false;
  let lineCb  = () => {};
  let stateCb = () => {};

  // Запущено всередині Android-застосунку (Capacitor)?
  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  // Чи є Bluetooth у цьому середовищі
  function available() {
    if (isNative()) return true;
    return !!(navigator.bluetooth && window.isSecureContext);
  }

  function handleValue(dataView) {
    const text = new TextDecoder().decode(dataView);
    text.split(/[\r\n]+/).forEach(s => {
      s = s.trim();
      if (s) lineCb(s);
    });
  }

  function onDisconnected() {
    chr = null;
    stateCb('disconnected');
  }

  // Вибрати пристрій і підключитися. showAll = показати всі BLE-пристрої поруч.
  async function connect(showAll) {
    if (isNative()) {
      throw new Error('Bluetooth для Android-застосунку додамо на етапі збирання .apk');
    }
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: [BLE_SERVICE] }
      : { filters: [{ services: [BLE_SERVICE] }, { namePrefix: 'JDY' }], optionalServices: [BLE_SERVICE] };

    device = await navigator.bluetooth.requestDevice(options);   // вікно вибору пристрою
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);

    stateCb('connecting', device.name || '');
    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    chr = await service.getCharacteristic(BLE_CHAR);

    useWithResponse = !!chr.properties.write && !chr.properties.writeWithoutResponse;
    chr.addEventListener('characteristicvaluechanged', e => handleValue(e.target.value));
    await chr.startNotifications();

    stateCb('connected', device.name || '');
  }

  async function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
  }

  // Надіслати текст (ділимо на шматки по 20 байт)
  async function send(text) {
    if (!chr) throw new Error('Немає з\'єднання');
    const data = new TextEncoder().encode(text);
    for (let i = 0; i < data.length; i += BLE_CHUNK) {
      const part = data.slice(i, i + BLE_CHUNK);
      if (useWithResponse && chr.writeValueWithResponse) await chr.writeValueWithResponse(part);
      else if (chr.writeValueWithoutResponse)            await chr.writeValueWithoutResponse(part);
      else                                               await chr.writeValue(part);
    }
  }

  return {
    available, isNative, connect, disconnect, send,
    set onLine(f)  { lineCb = f; },
    set onState(f) { stateCb = f; },
    get connected() { return !!chr; },
  };
})();
