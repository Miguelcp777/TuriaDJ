// ── Donde entra la siguiente cancion ─────────────────────────────────────────
// Regla unica, sin mandos que ajustar: la entrante se solapa OVERLAP_SEC segundos
// sobre la saliente. Lo unico que hay que averiguar es DONDE arranca ese
// solapamiento, y eso depende de como acabe la cancion:
//
//   final seco        -> se solapa sobre los ultimos 3 s del fichero
//   silencio de cola  -> se solapa sobre los ultimos 3 s CON MUSICA
//   fundido (fade)    -> la entrante entra 2 s despues de empezar el fundido
//
// La entrada es una serie de niveles RMS medidos en ventanas cortas del tramo
// final (ffmpeg astats). `silencedetect` NO sirve para esto: exige que el nivel
// siga bajo el umbral de forma continua, asi que un fundido con golpes sueltos lo
// resetea y da el final en el ultimo suspiro.
//
// Vive aparte de server.js para poder medirlo contra la biblioteca real sin
// arrancar el servidor (ver scripts de prueba).

const OVERLAP_SEC   = 3;    // solapamiento pedido
const FADE_LEAD_SEC = 2;    // en un fundido, cuanto se le deja sonar antes de entrar
const SILENCE_DB    = 20;   // dB bajo el nivel propio de la cancion => ya no se oye
const FULL_TOL_DB   = 4;    // margen para considerar que aun suena a nivel pleno
const FADE_MIN_SEC  = 3;    // menos que esto no es un fundido, es un final seco
const FADE_MAX_SEC  = 20;   // mas que esto no es un fundido, es un outro tranquilo
// Tope de seguridad por si la deteccion se equivoca. Empezo en 25 s y era DEMASIADO
// corto: "Niño" acaba de sonar en 229,8 s y arrastra 40 s de ruido a -45 dB, asi
// que el tope dejaba la mezcla dentro de ese ruido — justo el silencio que se
// queria evitar. Se acota ademas al 25% de la cancion para no destrozar las cortas.
const MAX_CUT_SEC   = 45;
const MAX_CUT_FRAC  = 0.25;
const TAIL_SCAN_SEC = 100;  // solo se analiza el final de la cancion
const WIN_SEC       = 0.5;  // duracion de cada ventana de medida

// OJO con astats: `ametadata=print` escribe una linea por CADA frame de audio
// (~26 ms), no una por ventana, y dentro de una ventana el valor es un RMS
// acumulado que va cayendo frame a frame. Usar `reset=N` a secas da una serie en
// dientes de sierra, no la curva de la cancion. `asetnsamples` agrupa el audio en
// bloques del tamaño que interesa y con `reset=1` sale exactamente un valor
// limpio por bloque.
const FILTRO_RMS = `asetnsamples=n=${Math.round(44100 * WIN_SEC)}:p=0,` +
                   'astats=metadata=1:reset=1,' +
                   'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-';

// `v`: niveles RMS en dBFS, uno por ventana, del tramo que empieza en el segundo
// `from`. Devuelve los tres puntos en milisegundos.
function puntosDeMezcla(v, from, durationSec) {
  const finMs = durationSec * 1000;
  const seco  = { audioEndMs: finMs, fadeMs: 0,
                  mixStartMs: Math.max(0, finMs - OVERLAP_SEC * 1000) };
  if (!v || v.length < 10) return seco;

  // Nivel "pleno" de la cancion: percentil 75 del tramo. La media no vale, porque
  // si el tramo es mayoritariamente fundido la media ya viene baja.
  const ord = [...v].sort((a, b) => a - b);
  const ref = ord[Math.floor(ord.length * 0.75)];
  const win = (durationSec - from) / v.length;    // segundos que dura cada ventana
  const seg = i => from + (i + 1) * win;          // instante donde acaba la ventana i

  // Se exigen DOS ventanas seguidas por encima del umbral. Con una sola bastaba
  // para que un pico suelto del final (un corte, un golpe de la sala) anclase ahi
  // el fin de la musica: medido en "MUCHACHA", una unica ventana a -29 dB pegada
  // al final movia el solape 4 s dentro de una cola inaudible a -37 dB.
  const dos = (k, umbral) => v[k] >= umbral && v[k - 1] >= umbral;

  let i = v.length - 1;
  while (i > 0 && !dos(i, ref - SILENCE_DB)) i--;
  const audioEnd = Math.min(durationSec, seg(i));  // ultima ventana que se oye

  let j = i;
  while (j > 0 && !dos(j, ref - FULL_TOL_DB)) j--;
  const fadeIni = seg(j);                          // ultima vez a nivel pleno
  let fade = audioEnd - fadeIni;
  if (fade < FADE_MIN_SEC || fade > FADE_MAX_SEC) fade = 0;

  let mix = fade ? fadeIni + FADE_LEAD_SEC : audioEnd - OVERLAP_SEC;
  // Topes: ni comerse media cancion ni mezclar antes de que haya arrancado.
  const tope = Math.min(MAX_CUT_SEC, durationSec * MAX_CUT_FRAC);
  if (durationSec - (mix + OVERLAP_SEC) > tope)
    mix = durationSec - tope - OVERLAP_SEC;
  mix = Math.max(5, Math.min(mix, durationSec - 0.5));
  return { audioEndMs: audioEnd * 1000, fadeMs: fade * 1000, mixStartMs: mix * 1000 };
}

module.exports = { puntosDeMezcla, OVERLAP_SEC, FADE_LEAD_SEC, TAIL_SCAN_SEC, FILTRO_RMS };
