/**
 * Sprite assignment shared between the Phaser scene and the React sidebar so
 * the same agent always shows the same character everywhere.
 */

export const TEACHER_SPRITES = [
  "teacher_male_01",
  "teacher_male_02",
  "teacher_male_03",
  "teacher_male_04",
  "teacher_female_01",
  "teacher_female_02",
  "teacher_female_03",
  "teacher_female_04",
];

export const STUDENT_SPRITES = [
  "su1_student_male_01",
  "su1_student_male_02",
  "su1_student_male_03",
  "su1_student_male_04",
  "su1_student_male_05",
  "su1_student_female_01",
  "su1_student_female_02",
  "su1_student_female_03",
  "su1_student_female_04",
  "su1_student_female_05",
];

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function teacherSpriteFor(sessionId: string): string {
  return TEACHER_SPRITES[hashString(sessionId) % TEACHER_SPRITES.length];
}

export function studentSpriteFor(subId: string): string {
  return STUDENT_SPRITES[hashString(subId) % STUDENT_SPRITES.length];
}
