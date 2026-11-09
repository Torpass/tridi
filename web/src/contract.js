// Mirror of the draft in docs/contrato.md, as JSDoc so editors can check it without a build step.
// When the contract is accepted, these move to the shared types file (W0.3).

/**
 * [x, y, z, visibility]: meters, y up, z toward the camera, origin at the hips of frame 0.
 * @typedef {[number, number, number, number]} Joint
 */

/**
 * [x, y, z]: meters, y up, z toward the camera, origin at the hips of frame 0.
 * @typedef {[number, number, number]} Point3D
 */

/**
 * @typedef {object} PoseFrame
 * @property {number} t
 * @property {Joint[]} joints  33 entries in MediaPipe Pose order
 * @property {{ left: Point3D[] | null, right: Point3D[] | null }} [hands]  21 points per seen hand (PoseClip v2)
 * @property {{ left: number, right: number }} [hands_conf]  detector confidence per hand (0 when unseen)
 * @property {{ left_foot: boolean, right_foot: boolean }} [contacts]  planted feet per frame (PoseClip v2)
 */

/**
 * @typedef {object} PoseClip
 * @property {string} id
 * @property {2} [version]
 * @property {'gvhmr' | 'gvhmr+wilor'} [capture]
 * @property {'smplx'} [body_model]
 * @property {number[]} [betas]
 * @property {{ static: boolean, f_mm: number }} [camera]
 * @property {'camera' | 'upload'} source
 * @property {string | null} source_file
 * @property {number} fps
 * @property {'mediapipe33'} skeleton
 * @property {'m'} units
 * @property {'hips'} origin
 * @property {{ track_id: number, selected_by: 'auto' | 'user' }} subject
 * @property {PoseFrame[]} frames
 * @property {{ valid_ratio: number, hands_ratio?: { left: number, right: number } }} quality
 */

/**
 * @typedef {object} PolicyMeta
 * @property {string} id
 * @property {string} robot
 * @property {string} mjcf  scene the policy was trained on
 * @property {number} obs_dim
 * @property {number} nu
 * @property {string[]} trained_on
 * @property {boolean} [sense_velocity]  whether mimic observation ends with pelvis linear velocity in body frame (3 floats)
 * @property {number} steps
 * @property {string} created_at
 */

export {};
