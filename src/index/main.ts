import "../shared/base.css";
import "./index.css";
import { svg } from "../shared/qrcode.js";
import { playUrl } from "../net/room";

const url = playUrl();
document.getElementById("url")!.textContent = url;

const box = document.getElementById("qr")!;
try {
  box.innerHTML = svg(url);
} catch {
  box.textContent = "QR 產生失敗";
}
