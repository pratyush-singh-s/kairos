if (location.hash === "#dark") document.documentElement.classList.add("dark");
// 6 frames a second: top left, top right, bottom left, again.
  const frames = [[0, 0], [-160, 0], [0, -160]];
  const hand = document.getElementById("hand");
  let i = 0;
  setInterval(() => {
    i = (i + 1) % frames.length;
    hand.style.backgroundPosition = frames[i][0] + "px " + frames[i][1] + "px";
  }, 1000 / 6);
