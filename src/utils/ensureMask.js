/**
 * Ensure the provided "string" is formatted according to the provided "mask".
 */
export default function ensureMask(string, mask) {
  let i = 0;

  /* Forced convert the given string to an actual string and ensure linear character indexes */
  const forcedString = string.toString().replace(/\W+/g, '');

  /* Get the overlay - the part of the string which goes beyond the mask */
  const overlay = forcedString.substr(mask.replace(/[^#]+/g, '').length, forcedString.length);

  /* Replace the hashes in the mask with the characters from the string, appending an overlay */
  return mask.replace(/#/gi, (a, b, c) => forcedString[i++] || '').trim() + overlay;
}
